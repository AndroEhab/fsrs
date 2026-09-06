#!/usr/bin/env node
// Validates chatgpt/openapi.yaml against the GPT Action requirements:
// - YAML parses (via js-yaml)
// - openapi is 3.x
// - info.title/description present (ChatGPT uses info.description for relevance)
// - servers present (base URL for the action)
// - every $ref target exists
// - every operation has operationId + summary + description + responses
// - required fields in request bodies are present in the schema
//
// Run: node validate-schema.mjs   (also wired as `npm run validate`)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { load as parseYaml } from "js-yaml";
const here = dirname(fileURLToPath(import.meta.url));
const doc = parseYaml(readFileSync(join(here, "openapi.yaml"), "utf8"));
const errors = [];

if (!doc.openapi || !String(doc.openapi).startsWith("3.")) {
  errors.push(`openapi version must be 3.x, got ${doc.openapi}`);
}
if (!doc.info?.title) errors.push("info.title missing");
if (!doc.info?.description) errors.push("info.description missing (ChatGPT uses it for action relevance)");
if (!doc.info?.version) errors.push("info.version missing");
if (!doc.servers?.length) errors.push("servers missing (needed for the GPT Action base URL)");
else for (const s of doc.servers) if (!s.url) errors.push("server entry missing url");

const schemas = doc.components?.schemas || {};
const defined = new Set(Object.keys(schemas));

function collectRefs(node, refs = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (node && typeof node === "object") {
    for (const [key, val] of Object.entries(node)) {
      if (key === "$ref") refs.push(val);
      else collectRefs(val, refs);
    }
  }
  return refs;
}

for (const ref of collectRefs(doc)) {
  const target = ref.replace("#/components/schemas/", "");
  if (!defined.has(target)) errors.push(`$ref "${ref}" has no matching schema definition`);
}

const OPERATION_KEYS = new Set(["get", "post", "patch", "delete", "put", "head", "options", "trace"]);
for (const [path, methods] of Object.entries(doc.paths || {})) {
  if (!path.startsWith("/")) errors.push(`path "${path}" must start with /`);
  for (const [method, op] of Object.entries(methods || {})) {
    if (!OPERATION_KEYS.has(method)) continue;
    const where = `${method.toUpperCase()} ${path}`;
    if (!op.operationId) errors.push(`${where}: missing operationId (ChatGPT references actions by it)`);
    if (!op.summary) errors.push(`${where}: missing summary`);
    if (!op.description) errors.push(`${where}: missing description (used by ChatGPT for action selection)`);
    if (!op.responses) errors.push(`${where}: missing responses`);
    if (op.requestBody) {
      const schema = op.requestBody.content?.["application/json"]?.schema;
      if (!schema) errors.push(`${where}: requestBody has no application/json schema`);
      if (schema?.$ref) {
        const target = schema.$ref.replace("#/components/schemas/", "");
        const def = schemas[target];
        if (def && def.required?.length) {
          for (const req of def.required) {
            if (!(req in (def.properties || {}))) {
              errors.push(`${where}: required field "${req}" missing from ${target} properties`);
            }
          }
        }
      }
    }
  }
}

if (errors.length) {
  console.error("VALIDATION FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const ops = Object.entries(doc.paths || {})
  .flatMap(([p, m]) => Object.keys(m || {}).filter((k) => OPERATION_KEYS.has(k)).map((k) => `${k.toUpperCase()} ${p}`));
console.log("openapi.yaml validation passed");
console.log(`  openapi: ${doc.openapi} | title: ${doc.info.title} | servers: ${doc.servers.map((s) => s.url).join(", ")}`);
console.log(`  operations (${ops.length}): ${ops.join(" | ")}`);
