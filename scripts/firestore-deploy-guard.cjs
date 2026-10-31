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
 *   4. the rules file fails an offline structural sanity check for its
 *      rules_version = '2' directive, balanced braces, comments, or strings.
 *
 * This is intentionally not a Firestore Rules grammar parser and does not
 * establish that a ruleset is semantically valid. firebase-tools' own deploy
 * parser (RulesDeploy.compile) calls the RULES API (testRuleset), a network
 * round-trip. The local ruleset module in firebase-tools is a thin API client,
 * NOT an offline parser. This guard never contacts the network and never deploys.
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

// Scan only enough Rules tokens to find the version directive and balance
// braces. This deliberately is not a Firestore Rules grammar/parser.
function scanRulesSource(src) {
  const tokens = [];
  let depth = 0;
  let hasVersionHeader = false;
  let i = 0;

  const remember = (type, value) => {
    if (tokens.length === 4) return;
    tokens.push({ type, value });
    if (tokens.length === 4 &&
        tokens[0].type === 'identifier' && tokens[0].value === 'rules_version' &&
        tokens[1].value === '=' &&
        (tokens[2].type === 'string' || tokens[2].type === 'number') && tokens[2].value === '2' &&
        tokens[3].value === ';') {
      hasVersionHeader = true;
    }
  };

  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      if (i >= src.length) failRulesSyntax('unterminated block comment');
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = '';
      let closed = false;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          if (i + 1 >= src.length) break;
          value += `\\${src[i + 1]}`;
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i += 1;
          closed = true;
          break;
        }
        value += src[i];
        i += 1;
      }
      if (!closed) failRulesSyntax('unterminated string literal');
      remember('string', value);
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i += 1;
      remember('identifier', src.slice(start, i));
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < src.length && /[0-9]/.test(src[i])) i += 1;
      remember('number', src.slice(start, i));
      continue;
    }

    remember('punctuation', ch);
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (depth < 0) failRulesSyntax('unbalanced braces: more "}" than "{"');
    i += 1;
  }

  if (!hasVersionHeader) {
    failRulesSyntax('missing "rules_version = \'2\';" header');
  }
  if (depth !== 0) {
    failRulesSyntax(`unbalanced braces: ${depth} unclosed "{"`);
  }
}

scanRulesSource(rulesSource);


console.log('[firestore predeploy guard] OK: firestore.rules present and structurally sound; firestore.indexes.json is well-formed.');
