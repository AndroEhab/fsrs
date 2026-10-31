const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a Firestore emulator port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function preflightTypeScript(rootFiles, functionsDir) {
  const ts = require('typescript');
  const configPath = path.join(functionsDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, functionsDir, undefined, configPath);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => functionsDir;
  const program = ts.createProgram({ rootNames: rootFiles, options, host });
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
    return false;
  }
  console.log(`[firestore] TypeScript preflight passed for ${rootFiles.length} selected suite file(s).`);
  return true;
}

function resolveFirebaseCli() {
  try {
    return require.resolve('firebase-tools/lib/bin/firebase');
  } catch {
    if (process.platform !== 'win32') return null;
    const located = spawnSync('where.exe', ['firebase.cmd'], {
      encoding: 'utf8',
    });
    const shim = located.stdout
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!shim) return null;
    const globalCli = path.join(
      path.dirname(shim),
      'node_modules',
      'firebase-tools',
      'lib',
      'bin',
      'firebase.js',
    );
    return fs.existsSync(globalCli) ? globalCli : null;
  }
}

async function main() {
  const suite = process.argv[2];
  const testNamePattern = process.argv[3];
  const suiteNames = ['rules', 'datastore', 'session', 'enrollment', 'decks', 'images', 'images-firestore', 'pagination', 'tags', 'paths'];
  if (!suiteNames.includes(suite)) {
    throw new Error('Usage: node scripts/run-firestore-emulator-tests.cjs <rules|datastore|session|enrollment|decks|images|images-firestore|pagination|tags|paths> [test-name-pattern]');
  }

  const functionsDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(functionsDir, '..');
  const datastoreSuites = ['session', 'enrollment', 'decks', 'images', 'pagination', 'tags', 'paths'];
  const suites = suite === 'datastore' ? datastoreSuites : [suite];
  const testFiles = suites.map((name) => name === 'rules'
    ? path.join(functionsDir, 'src', 'firestore.rules.test.ts')
    : name === 'paths'
      ? path.join(functionsDir, 'src', 'index.path.integration.test.ts')
      : path.join(functionsDir, 'src', 'flashcards',
        `${name === 'images-firestore' ? 'images' : name}.integration.test.ts`));
  const missingTestFiles = testFiles.filter((file) => !fs.existsSync(file));
  if (missingTestFiles.length > 0) {
    throw new Error(`Required integration suite file(s) missing: ${missingTestFiles.join(', ')}`);
  }
  if (!preflightTypeScript(testFiles, functionsDir)) {
    process.exitCode = 1;
    return;
  }
  const selectedTestNamePattern = suite === 'images-firestore' && !testNamePattern
    ? 'returns null for missing and foreign-owned uploads without Storage configuration'
    : testNamePattern;

  const port = await reserveFreePort();
  const needsStorageEmulator = suite === 'images' || suite === 'datastore' || suite === 'paths';
  const storagePort = needsStorageEmulator ? await reserveFreePort() : undefined;
  const tempConfig = path.join(
    functionsDir,
    `.firebase-${suite}-test-${process.pid}.json`,
  );
  let cliConfigDir;
  try {
    cliConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsrs-firebase-cli-'));
    const firebaseCli = resolveFirebaseCli();
    if (!firebaseCli) {
      throw new Error('Firebase CLI not found. Install firebase-tools locally or globally.');
    }
    const jestCli = require.resolve('jest/bin/jest');
    const jestConfig = path.join(functionsDir, 'jest.emulator.config.js');
    const jestCommand = [
      quote(process.execPath),
      quote(jestCli),
      '--config',
      quote(jestConfig),
      '--runTestsByPath',
      ...testFiles.map(quote),
      ...(selectedTestNamePattern ? ['--testNamePattern', quote(selectedTestNamePattern)] : []),
      '--runInBand',
    ].join(' ');
    const projectId = suite === 'rules' ? 'fsrs-rules-test' : 'demo-fsrs-datastore-test';
    const config = {
      ...(suite === 'rules' ? { firestore: { rules: path.join(repoRoot, 'firestore.rules') } } : {}),
      ...(needsStorageEmulator ? { storage: { rules: path.join(repoRoot, 'storage.rules') } } : {}),
      emulators: {
        firestore: { host: '127.0.0.1', port },
        ...(storagePort ? { storage: { host: '127.0.0.1', port: storagePort } } : {}),
        ui: { enabled: false },
        singleProjectMode: true,
      },
    };

    fs.writeFileSync(tempConfig, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`[firestore ${suite}] using project ${projectId} on ephemeral port ${port}`
      + (storagePort ? ` and Storage port ${storagePort}` : ''));
    const childEnvironment = {
      ...process.env,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}`,
      FIRESTORE_EMULATOR_PORT: String(port),
      GCLOUD_PROJECT: projectId,
      GOOGLE_CLOUD_PROJECT: projectId,
      GCP_PROJECT: projectId,
      FSRS_DATASTORE_PROJECT_ID: projectId,
      NO_UPDATE_NOTIFIER: '1',
      XDG_CONFIG_HOME: cliConfigDir,
    };
    delete childEnvironment.FIREBASE_STORAGE_EMULATOR_HOST;
    delete childEnvironment.STORAGE_EMULATOR_HOST;
    delete childEnvironment.FSRS_IMAGE_NO_STORAGE_PREFLIGHT;
    if (suite === 'images-firestore') childEnvironment.FSRS_IMAGE_NO_STORAGE_PREFLIGHT = 'true';
    if (storagePort) childEnvironment.FIREBASE_STORAGE_EMULATOR_HOST = `127.0.0.1:${storagePort}`;
    const result = spawnSync(
      process.execPath,
      [firebaseCli, 'emulators:exec', '--only', storagePort ? 'firestore,storage' : 'firestore',
        '--project', projectId, '--config', tempConfig, jestCommand],
      {
        env: childEnvironment,
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(tempConfig, { force: true });
    if (cliConfigDir) {
      fs.rmSync(cliConfigDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
