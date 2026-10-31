import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const port = 19000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["mock-server.mjs"], {
  cwd: new URL(".", import.meta.url),
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    HOME: process.env.HOME,
    PORT: String(port),
    API_KEY: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });
server.stderr.setEncoding("utf8").on("data", (chunk) => { serverOutput += chunk; });

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Mock exited during startup:\n${serverOutput}`);
    if (serverOutput.includes("listening on")) return;
    await delay(25);
  }
  throw new Error(`Mock failed to start:\n${serverOutput}`);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function runClient(args, trailingSlash = false) {
  const client = spawn(process.execPath, ["client.mjs", `${baseUrl}${trailingSlash ? "/" : ""}`, ...args], {
    cwd: new URL(".", import.meta.url),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [code, out] = await Promise.all([
    once(client, "exit").then(([exitCode]) => exitCode),
    new Response(client.stdout).text(),
  ]);
  assert.equal(code, 0, `client command failed (${args[0]}): ${out}`);
  return JSON.parse(out);
}

try {
  await waitForServer();
  const health = await runClient(["health"], true);
  assert.equal(health.status, 200, "trailing-slash base URL should reach /health");

  const invalidObject = await fetch(`${baseUrl}/createFlashcardHandler`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });
  assert.equal(invalidObject.status, 400, "null JSON body should be rejected, not crash the mock");
  assert.equal((await request("/health")).status, 200, "mock should keep serving after invalid JSON object shape");

  const rejectedCreate = await request("/bulkCreateFlashcardsHandler", {
    method: "POST",
    body: { cards: [{ front: "safe bulk create", back: "safe" }, { front: "invalid ref", back: "safe", deckId: "missing-safe-deck" }] },
  });
  assert.equal(rejectedCreate.status, 400);
  assert.equal((await request("/listFlashcardsHandler")).body.cards.length, 0, "failed bulk create must persist no cards");

  const created = await request("/createFlashcardHandler", { method: "POST", body: { front: "before", back: "safe" } });
  assert.equal(created.status, 201);
  const cardId = created.body.id;
  const rejectedUpdate = await request(`/updateFlashcardHandler/${cardId}`, {
    method: "PATCH",
    body: { front: "must stay before", deckId: "missing-safe-deck" },
  });
  assert.equal(rejectedUpdate.status, 400);
  assert.equal((await request(`/getFlashcardHandler/${cardId}`)).body.front, "before", "rejected single update must not partially mutate card");

  const rejectedBulkUpdate = await request("/bulkUpdateFlashcardsHandler", {
    method: "POST",
    body: { cards: [{ id: cardId, front: "must stay before" }, { id: "missing-safe-card", deckId: "missing-safe-deck" }] },
  });
  assert.equal(rejectedBulkUpdate.status, 400);
  assert.equal((await request(`/getFlashcardHandler/${cardId}`)).body.front, "before", "rejected bulk update must not partially mutate card");
  const french = await request("/createDeckHandler", { method: "POST", body: { name: "French Class" } });
  const spanish = await request("/createDeckHandler", { method: "POST", body: { name: "Spanish Class" } });
  const elsewhere = await request("/createDeckHandler", { method: "POST", body: { name: "Other Class" } });
  const matchingTags = ["a", "b,c", " space "];
  const matchFrench = await request("/createFlashcardHandler", {
    method: "POST", body: { front: "Paris capital", back: "Paris", deckId: french.body.id, tags: matchingTags },
  });
  const matchSpanish = await request("/createFlashcardHandler", {
    method: "POST", body: { front: "Paris river", back: "Seine", deckId: spanish.body.id, tags: matchingTags },
  });
  const wrongTags = await request("/createFlashcardHandler", {
    method: "POST", body: { front: "Paris decoy tags", back: "decoy", deckId: french.body.id, tags: ["a", "b,c"] },
  });
  const wrongDeck = await request("/createFlashcardHandler", {
    method: "POST", body: { front: "Paris decoy deck", back: "decoy", deckId: elsewhere.body.id, tags: matchingTags },
  });
  const queryClient = await runClient([
    "search", "--search", "paris",
    "--tags-all", "a", "--tags-all", "b,c", "--tags-all", " space ",
    "--decks", french.body.id, "--deck-names", "Spanish Class",
  ]);
  assert.equal(queryClient.status, 200);
  assert.deepEqual(
    queryClient.data.cards.map((card) => card.id).sort(),
    [matchFrench.body.id, matchSpanish.body.id].sort(),
    "legacy client must send literal repeated filters and match only their intersection/union result set",
  );
  const matchingIds = new Set(queryClient.data.cards.map((card) => card.id));
  assert.equal(matchingIds.has(wrongTags.body.id), false, "ALL tags must not split comma literals or trim padded values");
  assert.equal(matchingIds.has(wrongDeck.body.id), false, "the deck union must exclude decoy decks");

  console.log("MOCK CLIENT SMOKE PASS");
} finally {
  server.kill();
  await once(server, "exit").catch(() => {});
}
