import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const GUARD_PATH = path.resolve(__dirname, '../../scripts/firestore-deploy-guard.cjs');
const VALID_INDEXES = JSON.stringify({ indexes: [], fieldOverrides: [] });
const VALID_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} { allow read: if resource.data.label == 'brace } and escaped quote \\\'ok'; }
  }
}
`;

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-deploy-guard-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(GUARD_PATH, path.join(root, 'scripts', 'firestore-deploy-guard.cjs'));
  fs.writeFileSync(path.join(root, 'firestore.indexes.json'), VALID_INDEXES);
  return root;
}

function runGuard(root: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'firestore-deploy-guard.cjs')], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr };
}

describe('Firestore deploy guard CLI', () => {
  let root: string;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts balanced rules with comments, escaped quotes, and braces inside strings', () => {
    fs.writeFileSync(path.join(root, 'firestore.rules'), VALID_RULES);
    const result = runGuard(root);
    expect(result.status).toBe(0);
  });

  it.each<[string, string]>([
    ['unterminated block comment', `${VALID_RULES}/*`],
    ['unterminated string literal', `${VALID_RULES}\n"`],
    ['version directive only in a comment', `// rules_version = '2';\n${VALID_RULES.replace("rules_version = '2';\n", '')}`],
    ['version directive only in a string', `"rules_version = '2';";\n${VALID_RULES.replace("rules_version = '2';\n", '')}`],
  ])('rejects %s', (_label, rules) => {
    fs.writeFileSync(path.join(root, 'firestore.rules'), rules);
    expect(runGuard(root).status).toBe(1);
  });

  it('fails closed when the rules file is missing', () => {
    fs.rmSync(path.join(root, 'firestore.rules'), { force: true });
    expect(runGuard(root).status).toBe(1);
  });

  it('fails closed when indexes JSON is malformed', () => {
    fs.writeFileSync(path.join(root, 'firestore.rules'), VALID_RULES);
    fs.writeFileSync(path.join(root, 'firestore.indexes.json'), '{');
    expect(runGuard(root).status).toBe(1);
  });

  it('fails closed when indexes omit required arrays', () => {
    fs.writeFileSync(path.join(root, 'firestore.rules'), VALID_RULES);
    fs.writeFileSync(path.join(root, 'firestore.indexes.json'), '{}');
    expect(runGuard(root).status).toBe(1);
  });
});
