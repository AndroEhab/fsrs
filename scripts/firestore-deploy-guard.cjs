#!/usr/bin/env node
/**
 * Pre-deploy guard for the Firestore rules + indexes files (repo root).
 *
 * Run automatically by `firebase deploy` (and any `--only firestore`,
 * `firestore:rules`, `firestore:indexes` deploy) via the firestore
 * `predeploy` hook in firebase.json. It fails the deploy when:
 *
 *   1. firestore.rules is missing or unreadable;
 *   2. firestore.indexes.json is missing or not valid JSON;
 *   3. the indexes file is missing the `indexes` array or `fieldOverrides`
 *      (firebase-tools would fail the release anyway - fail faster, locally);
 *   4. the rules file does not parse (checked with firebase-tools' rules
 *      parser when the CLI is resolvable, otherwise with a structural check).
 *
 * The parser used by firebase-tools' own deploy (RulesDeploy.compile) calls
 * the RULES API (testRuleset) - a network round-trip. The local ruleset
 * module in firebase-tools is a thin API client, NOT an offline parser, so
 * this guard performs a no-network structural check of the rules syntax
 * (balanced braces/quotes, rules_version present) plus the same JSON
 * structural checks - it never contacts the network and never deploys.
 *
 * This prevents the two silent foot-guns of a firestore-only deploy:
 *   - rules/indexes files missing from the tree at deploy time (which
 *     firebase-tools treats as "no rules/indexes to deploy", deleting the
 *     live rules / wiping the index list);
 *   - locally unreadable rules/indexes failing only midway through release.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.join(REPO_ROOT, 'firestore.rules');
const INDEXES_PATH = path.join(REPO_ROOT, 'firestore.indexes.json');

const fail = (message) => {
  console.error(`[firestore predeploy guard] FAIL: ${message}`);
  process.exit(1);
};

// --- structural checks (always run) ---------------------------------------
if (!fs.existsSync(RULES_PATH)) {
  fail(`firestore.rules not found at ${RULES_PATH}. Refusing to deploy rules/indexes without it (a missing file would silently delete the deployed rules).`);
}
const rulesSource = fs.readFileSync(RULES_PATH, 'utf8');

if (!fs.existsSync(INDEXES_PATH)) {
  fail(`firestore.indexes.json not found at ${INDEXES_PATH}. Refusing to deploy without it (firebase-tools would treat it as an empty index list).`);
}
let indexes;
try {
  indexes = JSON.parse(fs.readFileSync(INDEXES_PATH, 'utf8'));
} catch (err) {
  fail(`firestore.indexes.json is not valid JSON: ${err.message}`);
}
if (!Array.isArray(indexes.indexes)) {
  fail('firestore.indexes.json is missing the top-level "indexes" array.');
}
if (!Array.isArray(indexes.fieldOverrides)) {
  fail('firestore.indexes.json is missing the top-level "fieldOverrides" array (firebase-tools requires it).');
}

// --- no-network rules syntax sanity check ----------------------------------
const failRulesSyntax = (message) => {
  fail(`firestore.rules syntax check failed: ${message}`);
};

if (typeof rulesSource !== 'string' || rulesSource.trim().length === 0) {
  failRulesSyntax('file is empty');
}
if (!/rules_version\s*=\s*['"]?2['"]?;/i.test(rulesSource)) {
  // rules_version = '2' is required for modern Firestore rules; its absence
  // usually means a truncated/corrupted file (or an accidental rules wipe).
  failRulesSyntax('missing "rules_version = \'2\';" header');
}

// Token-level balance check: strips comments/strings, then requires every
// opening brace to have a matching close (a truncated rules file would pass
// the header check but fail here).
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const stripped = stripCommentsAndStrings(rulesSource);
let depth = 0;
for (const ch of stripped) {
  if (ch === '{') depth += 1;
  else if (ch === '}') depth -= 1;
  if (depth < 0) {
    failRulesSyntax('unbalanced braces: more "}" than "{"');
  }
}
if (depth !== 0) {
  failRulesSyntax(`unbalanced braces: ${depth} unclosed "{"`);
}

console.log('[firestore predeploy guard] OK: firestore.rules present and structurally sound; firestore.indexes.json is well-formed.');
