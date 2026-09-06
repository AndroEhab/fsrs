#!/usr/bin/env node
// FSRS Flashcard API client — used to smoke-test the contract in openapi.yaml
// against a running server (local mock or deployed Firebase endpoint).
//
// The client mirrors the backend's NAMED Cloud Function routes (no /api prefix):
//   baseUrl examples:
//     mock:      http://localhost:8787
//     emulator:  http://127.0.0.1:5001/<project-id>/us-central1
//     deployed:  https://us-central1-<project-id>.cloudfunctions.net
//
// Usage:
//   node client.mjs <baseUrl> health
//   node client.mjs <baseUrl> create --front "..." --back "..." [--deck-id <id> | --deck <name>] [--tags a,b]
//   node client.mjs <baseUrl> bulk-create --front "..." --back "..." [--deck-id <id> | --deck <name>] [--tags a,b]
//                          [--front2 ... --back2 ...]  (repeat per card; up to 100)
//   node client.mjs <baseUrl> list [--deck-id <id> | --deck <name>] [--tags a,b] [--page-size N]
//   node client.mjs <baseUrl> due [--deck-id <id> | --deck <name>] [--page-size N] [--page-token T]
//   node client.mjs <baseUrl> review <id> --rating N [--review-at ISO]
//   node client.mjs <baseUrl> get <id>
//   node client.mjs <baseUrl> update <id> [--front "..." --back "..." --deck-id <id>|none --deck <name>|none --tags a,b]
//   node client.mjs <baseUrl> bulk-update --id <id> [--front ... --back ... --deck-id ... --deck ... --tags ...]
//                          [--id2 ...]  (repeat per card; up to 100)
//   node client.mjs <baseUrl> delete <id>
//   node client.mjs <baseUrl> bulk-delete --id <id> [--id2 ...]  (up to 100 ids)
//   node client.mjs <baseUrl> create-deck --name <name> [--description <desc>]
//   node client.mjs <baseUrl> list-decks [--page-size N]
//   node client.mjs <baseUrl> get-deck <id>
//   node client.mjs <baseUrl> update-deck <id> [--name <name>] [--description <desc>]
//   node client.mjs <baseUrl> delete-deck <id>
//   node client.mjs <baseUrl> migrate-decks          (maintenance: backfill deckId from legacy names)
//   node client.mjs <baseUrl> start-session [--deck-id <id>]     (review sessions, snapshot every due card)
//   node client.mjs <baseUrl> get-session <session-id>
//   node client.mjs <baseUrl> submit-review <session-id> --rating N [--review-at ISO]
//   node client.mjs <baseUrl> end-session <session-id>
//
// Auth: pass --api-key <key> to send the X-API-Key header (matches the
// backend's production auth and the GPT Action API-Key auth setting).
import process from "node:process";

const baseUrl = process.argv[2];
const command = process.argv[3];
if (!baseUrl || !command) {
  console.error("Usage: node client.mjs <baseUrl> <health|create|bulk-create|list|due|review|get|update|bulk-update|delete|bulk-delete|create-deck|list-decks|get-deck|update-deck|delete-deck|migrate-decks|attach-image|upload-image|list-images|remove-image|start-session|get-session|submit-review|end-session> [args]");
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
// Returns all values for a repeatable flag, collecting plain (--id) and
// digit-suffixed (--id2, --id3, ...) occurrences in order:
//   --id a --id2 b --id3 c → ['a','b','c']
function argAll(name) {
  const entries = [];
  const prefix = `--${name}`;
  for (let i = 4; i < process.argv.length; i += 1) {
    const flag = process.argv[i];
    if (!flag.startsWith(prefix) || i + 1 >= process.argv.length) continue;
    const suffix = flag.slice(prefix.length);
    if (suffix === "") entries.push({ index: 0, value: process.argv[i + 1] });
    else if (/^\d+$/.test(suffix)) entries.push({ index: Number(suffix), value: process.argv[i + 1] });
  }
  return entries.sort((a, b) => a.index - b.index).map((e) => e.value);
}
const apiKey = arg("api-key");

async function request(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

switch (command) {
  case "health": {
    const { status, data } = await request("GET", "/health");
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "create": {
    const front = arg("front");
    const back = arg("back");
    if (!front || !back) {
      console.error("create requires --front and --back");
      process.exit(2);
    }
    const body = { front, back };
    if (arg("deck-id")) body.deckId = arg("deck-id");
    if (arg("deck")) body.deck = arg("deck");
    if (arg("tags")) body.tags = arg("tags").split(",").map((t) => t.trim()).filter(Boolean);
    const { status, data } = await request("POST", "/createFlashcardHandler", body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "list": {
    const q = new URLSearchParams();
    if (arg("deck-id")) q.set("deckId", arg("deck-id"));
    if (arg("deck")) q.set("deck", arg("deck"));
    if (arg("tags")) q.set("tags", arg("tags"));
    if (arg("page-size")) q.set("pageSize", arg("page-size"));
    if (arg("page-token")) q.set("pageToken", arg("page-token"));
    const qs = q.toString();
    const { status, data } = await request("GET", `/listFlashcardsHandler${qs ? `?${qs}` : ""}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "due": {
    const q = new URLSearchParams();
    if (arg("deck-id")) q.set("deckId", arg("deck-id"));
    if (arg("deck")) q.set("deck", arg("deck"));
    if (arg("page-size")) q.set("pageSize", arg("page-size"));
    if (arg("page-token")) q.set("pageToken", arg("page-token"));
    const qs = q.toString();
    const { status, data } = await request("GET", `/dueFlashcardsHandler${qs ? `?${qs}` : ""}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "review": {
    const id = process.argv[4];
    const rating = arg("rating");
    if (!id || !rating) {
      console.error("review requires an id and --rating (1=Again, 2=Hard, 3=Good, 4=Easy)");
      process.exit(2);
    }
    const body = { rating: Number(rating) };
    if (arg("review-at")) body.reviewAt = arg("review-at");
    const { status, data } = await request("POST", `/reviewFlashcardHandler/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "get": {
    const id = process.argv[4];
    if (!id) {
      console.error("get requires an id");
      process.exit(2);
    }
    const { status, data } = await request("GET", `/getFlashcardHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "update": {
    const id = process.argv[4];
    if (!id) {
      console.error("update requires an id");
      process.exit(2);
    }
    const body = {};
    for (const name of ["front", "back", "deckId", "deck", "tags"]) {
      if (arg(name) !== undefined) {
        body[name] = name === "tags"
          ? arg(name).split(",").map((t) => t.trim()).filter(Boolean)
          : arg(name) === "none" ? null : arg(name);
      }
    }
    if (Object.keys(body).length === 0) {
      console.error("update requires at least one of --front/--back/--deck-id/--deck/--tags");
      process.exit(2);
    }
    const { status, data } = await request("PATCH", `/updateFlashcardHandler/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "delete": {
    const id = process.argv[4];
    if (!id) {
      console.error("delete requires an id");
      process.exit(2);
    }
    const { status, data } = await request("DELETE", `/deleteFlashcardHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 204) process.exitCode = 1;
    break;
  }
  case "bulk-create": {
    // Cards are grouped by an optional numeric suffix: --front/--back (card 1),
    // --front2/--back2 (card 2), etc. argAll collects both plain and suffixed
    // flags in order. Shared flags (--deck/--tags) apply to all cards when a
    // card does not set its own (--deck2/--tags2 override).
    const fronts = argAll("front");
    const backs = argAll("back");
    if (fronts.length === 0 || backs.length === 0 || fronts.length !== backs.length) {
      console.error("bulk-create requires matching --front/--back pairs (repeat --front2/--back2, --front3/--back3, ... for more cards)");
      process.exit(2);
    }
    if (fronts.length > 100) {
      console.error("bulk-create supports at most 100 cards");
      process.exit(2);
    }
    const deckId = arg("deck-id");
    const deck = arg("deck");
    const tags = arg("tags") ? arg("tags").split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const cards = fronts.map((front, i) => {
      const suffix = i === 0 ? "" : String(i + 1);
      const item = { front, back: backs[i] };
      const itemDeckId = arg(`deck-id${suffix}`);
      if (itemDeckId !== undefined) item.deckId = itemDeckId;
      else if (deckId !== undefined) item.deckId = deckId;
      const itemDeck = arg(`deck${suffix}`);
      if (itemDeck !== undefined) item.deck = itemDeck;
      else if (deck !== undefined) item.deck = deck;
      const itemTags = arg(`tags${suffix}`);
      if (itemTags !== undefined) item.tags = itemTags.split(",").map((t) => t.trim()).filter(Boolean);
      else if (tags !== undefined) item.tags = tags;
      return item;
    });
    const { status, data } = await request("POST", "/bulkCreateFlashcardsHandler", { cards });
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "bulk-update": {
    const ids = argAll("id");
    if (ids.length === 0) {
      console.error("bulk-update requires at least one --id");
      process.exit(2);
    }
    if (ids.length > 100) {
      console.error("bulk-update supports at most 100 cards");
      process.exit(2);
    }
    const cards = ids.map((id, i) => {
      const suffix = i === 0 ? "" : String(i + 1);
      const item = { id };
      for (const name of ["front", "back", "deckId", "deck", "tags"]) {
        const value = arg(`${name}${suffix}`);
        if (value !== undefined) item[name] = name === "tags" ? value.split(",").map((t) => t.trim()).filter(Boolean) : value;
      }
      return item;
    });
    const { status, data } = await request("POST", "/bulkUpdateFlashcardsHandler", { cards });
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "bulk-delete": {
    const ids = argAll("id");
    if (ids.length === 0) {
      console.error("bulk-delete requires at least one --id");
      process.exit(2);
    }
    if (ids.length > 100) {
      console.error("bulk-delete supports at most 100 ids");
      process.exit(2);
    }
    const { status, data } = await request("POST", "/bulkDeleteFlashcardsHandler", { ids });
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "create-deck": {
    const name = arg("name");
    if (!name) {
      console.error("create-deck requires --name");
      process.exit(2);
    }
    const body = { name };
    if (arg("description") !== undefined) body.description = arg("description");
    const { status, data } = await request("POST", "/createDeckHandler", body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "list-decks": {
    const q = new URLSearchParams();
    if (arg("page-size")) q.set("pageSize", arg("page-size"));
    const qs = q.toString();
    const { status, data } = await request("GET", `/listDecksHandler${qs ? `?${qs}` : ""}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "get-deck": {
    const id = process.argv[4];
    if (!id) {
      console.error("get-deck requires an id");
      process.exit(2);
    }
    const { status, data } = await request("GET", `/getDeckHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "update-deck": {
    const id = process.argv[4];
    if (!id) {
      console.error("update-deck requires an id");
      process.exit(2);
    }
    const body = {};
    if (arg("name") !== undefined) body.name = arg("name");
    if (arg("description") !== undefined) body.description = arg("description");
    if (Object.keys(body).length === 0) {
      console.error("update-deck requires at least one of --name/--description");
      process.exit(2);
    }
    const { status, data } = await request("PATCH", `/updateDeckHandler/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "delete-deck": {
    const id = process.argv[4];
    if (!id) {
      console.error("delete-deck requires an id");
      process.exit(2);
    }
    const { status, data } = await request("DELETE", `/deleteDeckHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "attach-image": {
    const id = process.argv[4];
    const url = arg("url");
    if (!id || !url) {
      console.error("attach-image requires a card id and --url");
      process.exit(2);
    }
    const body = { url };
    if (arg("alt") !== undefined) body.alt = arg("alt");
    if (arg("mime-type") !== undefined) body.mimeType = arg("mime-type");
    const { status, data } = await request("POST", `/attachImageHandler/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "upload-image": {
    const id = process.argv[4];
    const data = arg("data");
    const fileName = arg("file-name");
    const contentType = arg("content-type");
    if (!id || !data || !fileName || !contentType) {
      console.error("upload-image requires a card id, --data (base64), --file-name, and --content-type");
      process.exit(2);
    }
    const body = { data, fileName, contentType };
    if (arg("alt") !== undefined) body.alt = arg("alt");
    const { status, data: resp } = await request("POST", "/uploadImageHandler/" + encodeURIComponent(id), body);
    console.log(JSON.stringify({ status, data: resp }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "list-images": {
    const id = process.argv[4];
    if (!id) {
      console.error("list-images requires a card id");
      process.exit(2);
    }
    const { status, data } = await request("GET", `/listImagesHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "start-session": {
    const body = {};
    if (arg("deck-id")) body.deckId = arg("deck-id");
    // The session queue is never capped and never client-set — no limit flag.
    if (arg("limit")) {
      console.error("start-session does not accept --limit (the queue is the uncapped snapshot)");
      process.exit(2);
    }
    const { status, data } = await request("POST", "/startReviewSessionHandler", body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 201) process.exitCode = 1;
    break;
  }
  case "get-session": {
    const id = process.argv[4];
    if (!id) {
      console.error("get-session requires a session id");
      process.exit(2);
    }
    const { status, data } = await request("GET", `/getReviewSessionHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "submit-review": {
    const id = process.argv[4];
    const rating = arg("rating");
    if (!id || !rating) {
      console.error("submit-review requires a session id and --rating (1=Again, 2=Hard, 3=Good, 4=Easy)");
      process.exit(2);
    }
    const body = { rating: Number(rating) };
    if (arg("review-at")) body.reviewAt = arg("review-at");
    const { status, data } = await request("POST", `/submitSessionReviewHandler/${encodeURIComponent(id)}`, body);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  case "end-session": {
    const id = process.argv[4];
    if (!id) {
      console.error("end-session requires a session id");
      process.exit(2);
    }
    const { status, data } = await request("POST", `/endReviewSessionHandler/${encodeURIComponent(id)}`);
    console.log(JSON.stringify({ status, data }, null, 2));
    if (status !== 200) process.exitCode = 1;
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(2);
}
