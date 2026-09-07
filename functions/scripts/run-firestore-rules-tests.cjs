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
  const functionsDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(functionsDir, '..');
  const port = await reserveFreePort();
  const tempConfig = path.join(
    functionsDir,
    `.firebase-rules-test-${process.pid}.json`,
  );
  const cliConfigDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'fsrs-firebase-cli-'),
  );
  const firebaseCli = resolveFirebaseCli();
  if (!firebaseCli) {
    throw new Error(
      'Firebase CLI not found. Install firebase-tools locally or globally.',
    );
  }
  const jestCli = require.resolve('jest/bin/jest');
  const jestConfig = path.join(functionsDir, 'jest.rules.config.js');
  const testFile = path.join(functionsDir, 'src', 'firestore.rules.test.ts');
  const jestCommand = [
    quote(process.execPath),
    quote(jestCli),
    '--config',
    quote(jestConfig),
    '--runTestsByPath',
    quote(testFile),
    '--runInBand',
    '--forceExit',
  ].join(' ');

  const config = {
    firestore: {
      rules: path.join(repoRoot, 'firestore.rules'),
    },
    emulators: {
      firestore: {
        host: '127.0.0.1',
        port,
      },
      ui: {
        enabled: false,
      },
      singleProjectMode: true,
    },
  };

  try {
    fs.writeFileSync(tempConfig, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`[firestore rules] using ephemeral port ${port}`);
    const result = spawnSync(
      process.execPath,
      [
        firebaseCli,
        'emulators:exec',
        '--only',
        'firestore',
        '--project',
        'fsrs-rules-test',
        '--config',
        tempConfig,
        jestCommand,
      ],
      {
        cwd: functionsDir,
        env: {
          ...process.env,
          FIRESTORE_EMULATOR_PORT: String(port),
          NO_UPDATE_NOTIFIER: '1',
          XDG_CONFIG_HOME: cliConfigDir,
        },
        stdio: 'inherit',
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(tempConfig, { force: true });
    fs.rmSync(cliConfigDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
