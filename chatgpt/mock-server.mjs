#!/usr/bin/env node
// Local mock server implementing the exact contract in chatgpt/openapi.yaml,
// which mirrors the Firebase backend (functions/src/index.ts + validators.ts):
//   - each handler is a SEPARATE named route (no /api prefix):
//       /health, /createFlashcardHandler, /bulkCreateFlashcardsHandler,
//       /listFlashcardsHandler, /dueFlashcardsHandler,
//       /reviewFlashcardHandler/{id}, /getFlashcardHandler/{id},
//       /updateFlashcardHandler/{id}, /deleteFlashcardHandler/{id},
//       /bulkUpdateFlashcardsHandler, /bulkDeleteFlashcardsHandler,
//   - review sessions (startReviewSessionHandler, getReviewSessionHandler,
//     submitSessionReviewHandler, endReviewSessionHandler): snapshot EVERY
//     matching card id (no cap), apply the simplified FSRS schedule
//     on submit, and advance currentIndex/reviewedCount/ratingCounts/status —
//     mirroring the backend's reviewSessions semantics for local testing
//   - auth via X-API-Key enforced only when API_KEY env is set (backend:
//     NODE_ENV=production); /health is always public
//   - error shape { error, issues? }; health returns { status, timestamp }
//
// NOT for production — the Firebase backend in functions/ is the real
// implementation. This exists so schema + client can be exercised locally.
//
// Run:   node mock-server.mjs          (listens on 127.0.0.1:8787)
// Env:   PORT (default 8787), API_KEY (when set, requires X-API-Key header)
import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const API_KEY = process.env.API_KEY || "";

const cards = new Map(); // id -> card
let nextId = 1;
const decks = new Map(); // id -> deck
let nextDeckId = 1;
const sessions = new Map(); // id -> review session
let nextSessionId = 1;

// Finds a deck by exact name, or creates it (find-or-create like the backend).
function findOrCreateDeck(name) {
  for (const deck of decks.values()) {
    if (deck.name === name) return deck;
  }
  const now = nowTimestamp();
  const deck = { id: `deck_${String(nextDeckId++).padStart(4, "0")}`, name, createdAt: now, updatedAt: now };
  decks.set(deck.id, deck);
  return deck;
}

// Resolves a card input's deck reference: deckId (must exist) wins, else the
// legacy `deck` name is found-or-created. Returns { deckId, deck } or null.
function resolveDeckRef(body) {
  if (body.deckId !== undefined && body.deckId !== null) {
    const deck = decks.get(body.deckId);
    if (!deck) {
      const err = new Error(`Deck not found: ${body.deckId}`);
      err.status = 400;
      throw err;
    }
    return { deckId: body.deckId, deck: deck.name };
  }
  if (body.deck !== undefined && body.deck !== null) {
    const deck = findOrCreateDeck(body.deck);
    return { deckId: deck.id, deck: deck.name };
  }
  return null;
}

// Lazily resolves the default "Uncategorized" deck for the mock server.
function resolveDefaultDeck() {
  return findOrCreateDeck("Uncategorized");
}

// Mirrors backend Timestamp JSON: { _seconds, _nanoseconds } (protobuf style),
// NOT ISO 8601. Same behavior as firebase-admin Timestamp.now() serialization.
const nowTimestamp = () => {
  const t = Date.now();
  return { _seconds: Math.floor(t / 1000), _nanoseconds: (t % 1000) * 1000000 };
};

// Timestamp arithmetic helper: adds minutes to a wire-format timestamp.
const addMinutes = (wireTs, minutes) => {
  const ms = wireTs._seconds * 1000 + Math.floor(wireTs._nanoseconds / 1000000) + minutes * 60000;
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1000000 };
};

const tsToMs = (wireTs) => wireTs._seconds * 1000 + Math.floor(wireTs._nanoseconds / 1000000);

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Mirrors validators.ts (zod): reject unknown keys, validate known ones.
function validateFlashcard(body, { partial }) {
  const issues = [];
  const clean = {};
  for (const key of Object.keys(body)) {
    if (!["front", "back", "deckId", "deck", "tags"].includes(key)) issues.push({ path: [key], message: "Unrecognized key" });
  }
  if (!partial || body.front !== undefined) {
    if (typeof body.front !== "string" || body.front.length < 1 || body.front.length > 10000) {
      issues.push({ path: ["front"], message: "Front must be a string of 1-10000 characters" });
    } else clean.front = body.front;
  }
  if (!partial || body.back !== undefined) {
    if (typeof body.back !== "string" || body.back.length < 1 || body.back.length > 10000) {
      issues.push({ path: ["back"], message: "Back must be a string of 1-10000 characters" });
    } else clean.back = body.back;
  }
  if (!partial || body.deckId !== undefined) {
    if (body.deckId !== undefined && body.deckId === null) {
      issues.push({ path: ["deckId"], message: "Cannot set deckId to null; every card must belong to a deck" });
    } else if (body.deckId !== undefined && (typeof body.deckId !== "string" || body.deckId.length < 1 || body.deckId.length > 100)) {
      issues.push({ path: ["deckId"], message: "Deck id must be a string of 1-100 characters" });
    } else if (body.deckId !== undefined) clean.deckId = body.deckId;
  }
  if (!partial || body.deck !== undefined) {
    if (body.deck !== undefined && body.deck === null) {
      issues.push({ path: ["deck"], message: "Cannot set deck to null; every card must belong to a deck" });
    } else if (body.deck !== undefined && (typeof body.deck !== "string" || body.deck.length > 100)) {
      issues.push({ path: ["deck"], message: "Deck name must be a string of at most 100 characters" });
    } else if (body.deck !== undefined) clean.deck = body.deck;
  }
  if (!partial || body.tags !== undefined) {
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some((t) => typeof t !== "string" || t.length < 1 || t.length > 50)) {
        issues.push({ path: ["tags"], message: "Tags must be an array of 1-20 strings, each 1-50 characters" });
      } else clean.tags = body.tags;
    }
  }
  return { issues, data: clean };
}

// Mirrors validators.ts reviewFlashcardSchema: rating 1-4, optional ISO reviewAt.
function validateReview(body) {
  const issues = [];
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    issues.push({ path: ["rating"], message: "Rating must be an integer 1-4" });
  }
  if (body.reviewAt !== undefined && (typeof body.reviewAt !== "string" || Number.isNaN(Date.parse(body.reviewAt)))) {
    issues.push({ path: ["reviewAt"], message: "reviewAt must be an ISO 8601 datetime string" });
  }
  return { issues, rating };
}

function validationErrorResponse(res, issues) {
  return json(res, 400, { error: "Validation failed", issues });
}

// Simplified FSRS progression so local flows exercise the contract:
//  - New + Good        -> Learning, due +10m
//  - New + Again       -> Learning, due +1m
//  - Learning + Good   -> Review,   due +2d
//  - Learning + Again  -> Learning, due +1m
//  - Review + Good     -> Review,   due +2d
//  - Review + Again    -> Relearning, due +1m
const nextDueMinutes = (card, rating) => {
  if (card.state === 0) return rating === 1 ? 1 : 10;
  if (card.state === 1) return rating === 1 ? 1 : 2 * 24 * 60;
  if (card.state === 3) return rating === 1 ? 1 : 10;
  return rating === 1 ? 1 : 2 * 24 * 60; // Review
};

const nextState = (card, rating) => {
  if (card.state === 0) return 1;
  if (card.state === 1) return rating === 1 ? 1 : 2;
  if (card.state === 3) return rating === 1 ? 3 : 2;
  return rating === 1 ? 3 : 2; // Review
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,X-API-Key" });
    return res.end();
  }

  if (path === "/health" && method === "GET") {
    return json(res, 200, { status: "ok", timestamp: nowTimestamp() });
  }

  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return json(res, 401, { error: "Invalid or missing API key" });
  }

  if (path === "/createFlashcardHandler" && method === "POST") {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
    const { issues, data } = validateFlashcard(body, { partial: false });
    if (issues.length) return validationErrorResponse(res, issues);
    let deckRef;
    try {
      deckRef = resolveDeckRef(data);
    } catch (err) {
      if (err.status === 400) return json(res, 400, { error: "Validation failed", issues: [{ path: ["deckId"], message: err.message }] });
      throw err;
    }
    const id = `card_${String(nextId++).padStart(4, "0")}`;
    const now = nowTimestamp();
    // Every newly created card must belong to a deck; fall back to Uncategorized.
    const resolvedDeck = deckRef ?? resolveDefaultDeck();
    const card = {
      id,
      front: data.front,
      back: data.back,
      deckId: resolvedDeck.deckId,
      deck: resolvedDeck.deck,
      tags: data.tags ?? [],
      createdAt: now,
      updatedAt: now,
      due: now,
      state: 0,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      reviewLog: [],
      images: [],
    };
    cards.set(id, card);
    return json(res, 201, card);
  }

  if (path === "/bulkCreateFlashcardsHandler" && method === "POST") {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
    if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 100) {
      return json(res, 400, { error: "Validation failed", issues: [{ path: ["cards"], message: "cards must be an array of 1-100 items" }] });
    }
    // Validate EVERY item before writing any (atomic — no partial success).
    const validated = [];
    for (const item of body.cards) {
      const { issues, data } = validateFlashcard(item, { partial: false });
      if (issues.length) return validationErrorResponse(res, issues);
      validated.push(data);
    }
    const now = nowTimestamp();
    const created = [];
    for (const data of validated) {
      let deckRef;
      try {
        deckRef = resolveDeckRef(data);
      } catch (err) {
        if (err.status === 400) return json(res, 400, { error: "Validation failed", issues: [{ path: ["deckId"], message: err.message }] });
        throw err;
      }
      const id = `card_${String(nextId++).padStart(4, "0")}`;
      // Every newly created card must belong to a deck; fall back to Uncategorized.
      const resolvedDeck = deckRef ?? resolveDefaultDeck();
      const card = {
        id,
        front: data.front,
        back: data.back,
        deckId: resolvedDeck.deckId,
        deck: resolvedDeck.deck,
        tags: data.tags ?? [],
        createdAt: now,
        updatedAt: now,
        due: now,
        state: 0,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        reviewLog: [],
      images: [],
      };
      cards.set(id, card);
      created.push(card);
    }
    return json(res, 201, { cards: created });
  }

  if (path === "/listFlashcardsHandler" && method === "GET") {
    // createdAt is a wire-format timestamp object; sort by its epoch ms.
    let result = [...cards.values()].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const deckId = url.searchParams.get("deckId");
    if (deckId) result = result.filter((c) => c.deckId === deckId);
    const deck = url.searchParams.get("deck");
    if (deck) result = result.filter((c) => c.deck === deck);
    const tags = url.searchParams.get("tags");
    if (tags) {
      const wanted = tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (wanted.length) result = result.filter((c) => wanted.some((t) => c.tags.includes(t))); // array-contains-any
    }
    const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") || 20), 1), 100);
    let offset = 0;
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken) {
      const idx = result.findIndex((c) => c.id === pageToken);
      if (idx !== -1) offset = idx + 1; // startAfter(tokenDoc)
    }
    const page = result.slice(offset, offset + pageSize);
    const nextPageToken = offset + pageSize < result.length ? page[page.length - 1].id : null;
    return json(res, 200, { cards: page, nextPageToken });
  }

  if (path === "/dueFlashcardsHandler" && method === "GET") {
    const now = Date.now();
    let result = [...cards.values()]
      .filter((c) => tsToMs(c.due) <= now)
      .sort((a, b) => tsToMs(a.due) - tsToMs(b.due));
    const deckId = url.searchParams.get("deckId");
    if (deckId) result = result.filter((c) => c.deckId === deckId);
    const deck = url.searchParams.get("deck");
    if (deck) result = result.filter((c) => c.deck === deck);
    const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") || 20), 1), 100);
    let offset = 0;
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken) {
      const idx = result.findIndex((c) => c.id === pageToken);
      if (idx !== -1) offset = idx + 1; // startAfter(tokenDoc)
    }
    const page = result.slice(offset, offset + pageSize);
    const nextPageToken = offset + pageSize < result.length ? page[page.length - 1].id : null;
    return json(res, 200, { cards: page, nextPageToken });
  }

  if (path === "/countFlashcardsHandler" && method === "GET") {
    const now = Date.now();
    // Mirror the backend count contract: optional deckId/deck/tags filters
    // (AND), exact state buckets from the stored FSRS state, and an optional
    // groupBy=deck breakdown. Pure aggregate — the response carries no card
    // records (the real backend uses Firestore count() aggregations).
    const deckId = url.searchParams.get("deckId");
    const deck = url.searchParams.get("deck");
    const tags = url.searchParams.get("tags");
    const groupBy = url.searchParams.get("groupBy");
    // Backend mirror: deckId wins when both deckId and deck are given
    // (list/due convention); groupBy is validated to 'deck' and is mutually
    // exclusive with every filter (validators.ts countFlashcardsQuerySchema).
    if (groupBy !== null && groupBy !== "deck") {
      return json(res, 400, {
        error: "Validation failed",
        issues: [{ path: ["groupBy"], message: "Invalid enum value. Expected 'deck'" }],
      });
    }
    if (groupBy !== null && (deckId !== null || deck !== null || tags !== null)) {
      return json(res, 400, {
        error: "Validation failed",
        issues: [{ path: ["groupBy"], message: "groupBy is a whole-library breakdown and cannot be combined with deckId/deck/tags filters" }],
      });
    }
    const wantedTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
    const deckScope = deckId !== null ? deckId : deck; // deckId wins
    const inScope = (c) =>
      (!deckScope || (deckId !== null ? c.deckId === deckId : c.deck === deck)) &&
      (wantedTags.length === 0 || wantedTags.some((t) => (c.tags || []).includes(t)));

    const countState = (list) => {
      const stateOf = (c) => (c.state === undefined ? 0 : c.state);
      return {
        total: list.length,
        new: list.filter((c) => stateOf(c) === 0).length,
        learning: list.filter((c) => stateOf(c) === 1).length,
        mature: list.filter((c) => stateOf(c) === 2 || stateOf(c) === 3).length,
        due: list.filter((c) => tsToMs(c.due) <= now).length,
      };
    };

    // groupBy is validated to be standalone (no deck/tag filters): a
    // whole-library per-deck breakdown. Mirrors the backend: deck ENTITIES
    // drive the keys (metadata only) and each deck's cards are the union of
    // its deckId references and its legacy `deck`-name string (deck names
    // are unique, so one deck never splits); cards with no deck entity are
    // reported as a derived deck-less remainder entry (deckId/deck null).
    const scoped = [...cards.values()].filter(inScope);
    const result = { counts: countState(scoped) };
    if (groupBy === "deck") {
      const byDeck = [...decks.values()]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((d) => {
          const list = [...cards.values()].filter((c) => c.deck === d.name || c.deckId === d.id);
          return { deckId: d.id, deck: d.name, counts: countState(list) };
        });
      const attributed = byDeck.reduce(
        (acc, e) => ({
          total: acc.total + e.counts.total,
          new: acc.new + e.counts.new,
          learning: acc.learning + e.counts.learning,
          mature: acc.mature + e.counts.mature,
          due: acc.due + e.counts.due,
        }),
        { total: 0, new: 0, learning: 0, mature: 0, due: 0 },
      );
      const remainder = {
        total: result.counts.total - attributed.total,
        new: result.counts.new - attributed.new,
        learning: result.counts.learning - attributed.learning,
        mature: result.counts.mature - attributed.mature,
        due: result.counts.due - attributed.due,
      };
      if (remainder.total > 0) byDeck.push({ deckId: null, deck: null, counts: remainder });
      result.byDeck = byDeck;
    }
    return json(res, 200, result);
  }

  const match = path.match(/^\/(getFlashcardHandler|updateFlashcardHandler|deleteFlashcardHandler|reviewFlashcardHandler)\/([^/]+)$/);
  if (match) {
    const handler = match[1];
    const rawId = decodeURIComponent(match[2]);
    const card = cards.get(rawId);

    if (handler === "getFlashcardHandler") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      return json(res, 200, card);
    }
    if (handler === "updateFlashcardHandler") {
      if (method !== "PATCH") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      const { issues, data } = validateFlashcard(body, { partial: true });
      if (issues.length) return validationErrorResponse(res, issues);
      for (const k of Object.keys(data)) card[k] = data[k];
      // Deck reference handling: explicit null rejected; a value resolves to deckId+name.
      if (data.deckId === null || data.deck === null) {
        return json(res, 400, { error: "Cannot detach a card from its deck; every card must belong to a deck" });
      }
      if (data.deckId !== undefined || data.deck !== undefined) {
        let deckRef;
        try {
          deckRef = resolveDeckRef(data);
        } catch (err) {
          if (err.status === 400) return json(res, 400, { error: "Validation failed", issues: [{ path: ["deckId"], message: err.message }] });
          throw err;
        }
        if (deckRef) {
          card.deckId = deckRef.deckId;
          card.deck = deckRef.deck;
        }
      }
      card.updatedAt = nowTimestamp();
      return json(res, 200, card);
    }
    if (handler === "deleteFlashcardHandler") {
      if (method !== "DELETE") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      cards.delete(rawId);
      res.writeHead(204);
      return res.end();
    }
    if (handler === "reviewFlashcardHandler") {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      const { issues, rating } = validateReview(body);
      if (issues.length) return validationErrorResponse(res, issues);
      const reviewAt = body.reviewAt !== undefined ? new Date(body.reviewAt) : new Date();
      const reviewWire = {
        _seconds: Math.floor(reviewAt.getTime() / 1000),
        _nanoseconds: (reviewAt.getTime() % 1000) * 1000000,
      };
      const priorState = card.state;
      const priorDue = card.due;
      const logEntry = {
        rating,
        state: priorState,
        review: reviewWire,
        due: priorDue,
        stability: card.stability,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
      };
      // Compute the next-due delay from the PRIOR state: nextState() mutates
      // card.state below, and nextDueMinutes() must see the state the review
      // started from (New+Good → +10m, not 2 days).
      const dueMinutes = nextDueMinutes(card, rating);
      card.state = nextState(card, rating);
      card.reps += 1;
      if (card.state === 3) card.lapses += 1;
      card.stability = rating === 1 ? Math.max(0.2, card.stability / 2) : (card.stability || 2.3) * 1.4;
      card.difficulty = Math.max(1, Math.min(10, card.difficulty || 5) + (rating === 4 ? -0.5 : rating === 1 ? 0.5 : 0));
      // The next due time is relative to the REVIEW time (like the real FSRS
      // scheduler), not the current wall clock.
      card.due = addMinutes(reviewWire, dueMinutes);
      card.lastReview = reviewWire;
      card.updatedAt = nowTimestamp();
      card.reviewLog = [...card.reviewLog, logEntry];
      return json(res, 201, { card, reviewLogItem: logEntry });
    }
  }

  if (path === "/bulkUpdateFlashcardsHandler" && method === "POST") {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
    if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 100) {
      return json(res, 400, { error: "Validation failed", issues: [{ path: ["cards"], message: "cards must be an array of 1-100 items" }] });
    }
    // Validate EVERY item (id required) before touching any card. The `id`
    // field is extracted first — validateFlashcard only knows patch keys.
    const validated = [];
    for (const item of body.cards) {
      if (typeof item.id !== "string" || item.id.length < 1) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["cards", "id"], message: "Card id is required" }] });
      }
      const patch = { ...item };
      delete patch.id;
      const { issues, data } = validateFlashcard(patch, { partial: true });
      if (issues.length) return validationErrorResponse(res, issues);
      validated.push({ id: item.id, data });
    }
    const updated = [];
    for (const { id, data } of validated) {
      const card = cards.get(id);
      if (!card) continue; // nonexistent ids are omitted, like the backend
      // Deck reference handling: explicit null rejected; a value resolves to deckId+name.
      if (data.deckId === null || data.deck === null) {
        return json(res, 400, { error: "Cannot detach a card from its deck; every card must belong to a deck" });
      }
      for (const k of Object.keys(data)) card[k] = data[k];
      if (data.deckId !== undefined || data.deck !== undefined) {
        let deckRef;
        try {
          deckRef = resolveDeckRef(data);
        } catch (err) {
          if (err.status === 400) return json(res, 400, { error: "Validation failed", issues: [{ path: ["deckId"], message: err.message }] });
          throw err;
        }
        if (deckRef) {
          card.deckId = deckRef.deckId;
          card.deck = deckRef.deck;
        }
      }
      card.updatedAt = nowTimestamp();
      updated.push(card);
    }
    return json(res, 200, { cards: updated });
  }

  /* ------------------------------------------------------------------ */
  /* Decks                                                               */
  /* ------------------------------------------------------------------ */

  function validateDeck(body, { partial }) {
    const issues = [];
    const clean = {};
    for (const key of Object.keys(body)) {
      if (!["name", "description"].includes(key)) issues.push({ path: [key], message: "Unrecognized key" });
    }
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 100) {
        issues.push({ path: ["name"], message: "Deck name must be a string of 1-100 characters" });
      } else clean.name = body.name;
    }
    if (!partial || body.description !== undefined) {
      if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 500)) {
        issues.push({ path: ["description"], message: "Description must be a string of at most 500 characters" });
      } else if (body.description !== undefined) clean.description = body.description;
    }
    return { issues, data: clean };
  }

  if (path === "/createDeckHandler" && method === "POST") {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
    const { issues, data } = validateDeck(body, { partial: false });
    if (issues.length) return validationErrorResponse(res, issues);
    for (const deck of decks.values()) {
      if (deck.name === data.name) {
        return json(res, 400, { error: `A deck named \"${data.name}\" already exists` });
      }
    }
    const now = nowTimestamp();
    const deck = { id: `deck_${String(nextDeckId++).padStart(4, "0")}`, name: data.name, createdAt: now, updatedAt: now };
    if (data.description !== undefined) deck.description = data.description;
    decks.set(deck.id, deck);
    return json(res, 201, deck);
  }

  if (path === "/listDecksHandler" && method === "GET") {
    let result = [...decks.values()].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") || 20), 1), 100);
    let offset = 0;
    const pageToken = url.searchParams.get("pageToken");
    if (pageToken) {
      const idx = result.findIndex((d) => d.id === pageToken);
      if (idx !== -1) offset = idx + 1;
    }
    const page = result.slice(offset, offset + pageSize);
    const nextPageToken = offset + pageSize < result.length ? page[page.length - 1].id : null;
    return json(res, 200, { decks: page, nextPageToken });
  }

  const deckMatch = path.match(/^\/(getDeckHandler|updateDeckHandler|deleteDeckHandler)\/([^/]+)$/);
  if (deckMatch) {
    const handler = deckMatch[1];
    const rawId = decodeURIComponent(deckMatch[2]);
    const deck = decks.get(rawId);

    if (handler === "getDeckHandler") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (!deck) return json(res, 404, { error: "Deck not found" });
      return json(res, 200, deck);
    }
    if (handler === "updateDeckHandler") {
      if (method !== "PATCH") return json(res, 405, { error: "Method not allowed" });
      if (!deck) return json(res, 404, { error: "Deck not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      const { issues, data } = validateDeck(body, { partial: true });
      if (issues.length) return validationErrorResponse(res, issues);
      if (data.name !== undefined && data.name !== deck.name) {
        for (const other of decks.values()) {
          if (other.id !== deck.id && other.name === data.name) {
            return json(res, 400, { error: `A deck named \"${data.name}\" already exists` });
          }
        }
        const oldName = deck.name;
        deck.name = data.name;
        // Rename rewrites the denormalized deck name on referencing cards.
        for (const card of cards.values()) {
          if (card.deckId === deck.id || card.deck === oldName) {
            card.deck = data.name;
            card.updatedAt = nowTimestamp();
          }
        }
      }
      if (data.description !== undefined) deck.description = data.description;
      deck.updatedAt = nowTimestamp();
      return json(res, 200, deck);
    }
    if (handler === "deleteDeckHandler") {
      if (method !== "DELETE") return json(res, 405, { error: "Method not allowed" });
      if (!deck) return json(res, 404, { error: "Deck not found" });
      // Protect the system placeholder deck — deleting it breaks the invariant.
      if (deck.name === "Uncategorized") {
        return json(res, 400, { error: 'Cannot delete the "Uncategorized" deck; it is a system-protected placeholder' });
      }
      // Reassign cards to the Uncategorized deck — NEVER delete them.
      const defaultDeck = resolveDefaultDeck();
      let reassignedCards = 0;
      for (const card of cards.values()) {
        if (card.deckId === deck.id || card.deck === deck.name) {
          card.deckId = defaultDeck.deckId;
          card.deck = defaultDeck.deck;
          card.updatedAt = nowTimestamp();
          reassignedCards += 1;
        }
      }
      decks.delete(deck.id);
      return json(res, 200, { deleted: true, reassignedCards });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Assign deckless cards to Uncategorized                               */
  /* ------------------------------------------------------------------ */

  if (path === "/assignDecklessHandler" && method === "POST") {
    const defaultDeck = resolveDefaultDeck();
    let assigned = 0;
    for (const card of cards.values()) {
      if (card.deckId === undefined && card.deck === undefined) {
        card.deckId = defaultDeck.deckId;
        card.deck = defaultDeck.deck;
        card.updatedAt = nowTimestamp();
        assigned += 1;
      }
    }
    return json(res, 200, { assigned });
  }

  /* ------------------------------------------------------------------ */
  /* Card images                                                         */
  /* ------------------------------------------------------------------ */

  const ALLOWED_IMAGE_MIME = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp", "image/svg+xml",
  ]);
  const ALLOWED_UPLOAD_MIME = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp",
  ]);
  const EXT_TO_MIME = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
  };
  const MAX_CARD_IMAGES = 5;
  const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

  function validateImageUrl(url, mimeType) {
    if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
      return "Image URL must be a string of 1-2048 characters";
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "Image URL is not a valid URL";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "Image URL must use http(s)";
    }
    if (mimeType !== undefined) {
      if (!ALLOWED_IMAGE_MIME.has(String(mimeType).toLowerCase())) {
        return `Unsupported image MIME type: ${mimeType}`;
      }
      return null;
    }
    const lastSegment = parsed.pathname.split("/").pop() || "";
    const ext = lastSegment.includes(".") ? lastSegment.split(".").pop().toLowerCase() : "";
    if (!EXT_TO_MIME[ext]) {
      return "Image URL must point to an allowed image type (jpeg/png/gif/webp/avif/bmp/svg) or declare a valid mimeType";
    }
    return null;
  }

  const imageMatch = path.match(/^\/(attachImageHandler|uploadImageHandler|listImagesHandler|removeImageHandler)\/([^/]+)$/);
  if (imageMatch) {
    const handler = imageMatch[1];
    const rawId = decodeURIComponent(imageMatch[2]);
    const card = cards.get(rawId);

    if (handler === "attachImageHandler") {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      if (typeof body.url !== "string" || body.url.length < 1 || body.url.length > 2048) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["url"], message: "Image URL is required (1-2048 chars)" }] });
      }
      if (body.alt !== undefined && (typeof body.alt !== "string" || body.alt.length > 500)) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["alt"], message: "Alt text too long" }] });
      }
      if (body.mimeType !== undefined && (typeof body.mimeType !== "string" || body.mimeType.length > 100)) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["mimeType"], message: "MIME type too long" }] });
      }
      const urlErr = validateImageUrl(body.url, body.mimeType);
      if (urlErr) return json(res, 400, { error: urlErr });
      const images = card.images ?? [];
      if (images.length >= MAX_CARD_IMAGES) {
        return json(res, 400, { error: `A card can have at most ${MAX_CARD_IMAGES} images` });
      }
      const image = { id: 'img_' + Math.random().toString(36).slice(2, 12), url: body.url, addedAt: nowTimestamp() };
      if (body.alt !== undefined) image.alt = body.alt;
      if (body.mimeType !== undefined) image.mimeType = String(body.mimeType).toLowerCase();
      card.images = [...images, image];
      card.updatedAt = nowTimestamp();
      return json(res, 201, { card, image });
    }
    if (handler === "uploadImageHandler") {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      if (typeof body.data !== "string" || body.data.length < 1 || body.data.length > 14000012) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["data"], message: "Image data is required (base64, within the size limit)" }] });
      }
      if (typeof body.fileName !== "string" || body.fileName.length < 1 || body.fileName.length > 255) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["fileName"], message: "fileName is required (1-255 chars)" }] });
      }
      if (typeof body.contentType !== "string" || !ALLOWED_UPLOAD_MIME.has(String(body.contentType).toLowerCase())) {
        return json(res, 400, { error: "Unsupported image content type (allowed: jpeg/png/gif/webp/avif/bmp; SVG is not accepted for upload)" });
      }
      if (body.alt !== undefined && (typeof body.alt !== "string" || body.alt.length > 500)) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["alt"], message: "Alt text too long" }] });
      }
      let buffer;
      try {
        buffer = Buffer.from(body.data, "base64");
        if (buffer.toString("base64").replace(/=+$/, "") !== String(body.data).replace(/=+$/, "")) throw new Error("non-canonical");
      } catch {
        return json(res, 400, { error: "Image data is not valid base64" });
      }
      if (buffer.length === 0) return json(res, 400, { error: "Image data is empty" });
      if (buffer.length > MAX_IMAGE_UPLOAD_BYTES) return json(res, 400, { error: "Image exceeds the 10 MiB upload limit" });
      const images = card.images ?? [];
      if (images.length >= MAX_CARD_IMAGES) {
        return json(res, 400, { error: "A card can have at most " + MAX_CARD_IMAGES + " images" });
      }
      const extMap = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp" };
      const ext = extMap[String(body.contentType).toLowerCase()] || "img";
      const id = "img_" + Math.random().toString(36).slice(2, 12);
      const storagePath = "card-images/" + rawId + "/" + id + "." + ext;
      const downloadUrl = "https://storage.example.com/" + storagePath + "?signed=1";
      const image = { id, url: downloadUrl, mimeType: String(body.contentType).toLowerCase(), addedAt: nowTimestamp(), storagePath, downloadUrl, sizeBytes: buffer.length };
      if (body.alt !== undefined) image.alt = body.alt;
      card.images = [...images, image];
      card.updatedAt = nowTimestamp();
      return json(res, 201, { card, image });
    }
    if (handler === "listImagesHandler") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      return json(res, 200, { cardId: rawId, images: card.images ?? [] });
    }
    if (handler === "removeImageHandler") {
      if (method !== "DELETE") return json(res, 405, { error: "Method not allowed" });
      if (!card) return json(res, 404, { error: "Flashcard not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      if (typeof body.url !== "string" || body.url.length < 1) {
        return json(res, 400, { error: "Validation failed", issues: [{ path: ["url"], message: "Image URL is required" }] });
      }
      const remaining = (card.images ?? []).filter((img) => img.url !== body.url);
      if (remaining.length === (card.images ?? []).length) {
        return json(res, 200, { cardId: rawId, removed: false });
      }
      card.images = remaining;
      card.updatedAt = nowTimestamp();
      return json(res, 200, { cardId: rawId, removed: true });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Review sessions                                                     */
  /* ------------------------------------------------------------------ */

  function validateSessionStart(body) {
    const issues = [];
    const clean = {};
    for (const key of Object.keys(body)) {
      if (key !== "deckId") issues.push({ path: [key], message: "Unrecognized key" });
    }
    if (body.deckId !== undefined) {
      if (typeof body.deckId !== "string" || body.deckId.length < 1 || body.deckId.length > 100) {
        issues.push({ path: ["deckId"], message: "Deck id must be a string of 1-100 characters" });
      } else clean.deckId = body.deckId;
    }
    return { issues, data: clean };
  }

  function validateSessionReview(body) {
    return validateReview(body); // same shape: rating 1-4, optional ISO reviewAt
  }

  function emptyRatingCounts() {
    return { again: 0, hard: 0, good: 0, easy: 0, ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 } };
  }

  // Applies one rating to the counters (named fields + numeric map).
  function bumpRatingCounts(counts, rating) {
    const names = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
    const name = names[rating];
    return {
      ...counts,
      [name]: counts[name] + 1,
      ratingCounts: { ...counts.ratingCounts, [rating]: (counts.ratingCounts[rating] ?? 0) + 1 },
    };
  }

  // The current card of a session, or null when exhausted/deleted.
  function sessionCurrentCard(session) {
    if (session.status !== "active" || session.currentIndex >= session.cardIds.length) return null;
    const card = cards.get(session.cardIds[session.currentIndex]);
    return card || null;
  }

  // Human-readable mode tag exposed on every session response, matching the
  // MCP tool's first line: "[Spaced repetition review · N cards due]".
  function sessionModeTag(session) {
    return `[Spaced repetition review · ${session.dueCount} cards due]`;
  }

  // Adds the modeTag to a session before returning it to the client.
  function withModeTag(session) {
    return { ...session, modeTag: sessionModeTag(session) };
  }

  if (path === "/startReviewSessionHandler" && method === "POST") {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
    const { issues, data } = validateSessionStart(body);
    if (issues.length) return validationErrorResponse(res, issues);
    // Snapshot EVERY matching card (due <= now, earliest first) — the queue
    // is never capped (no limit, no truncation/continuation).
    const now = Date.now();
    let due = [...cards.values()]
      .filter((c) => tsToMs(c.due) <= now)
      .sort((a, b) => tsToMs(a.due) - tsToMs(b.due));
    if (data.deckId) due = due.filter((c) => c.deckId === data.deckId);
    const cardIds = due.map((c) => c.id);
    const id = `session_${String(nextSessionId++).padStart(4, "0")}`;
    const session = {
      id,
      apiKeyName: API_KEY ? "mock-key" : "unknown",
      status: "active",
      mode: "spaced_repetition",
      limit: cardIds.length,
      dueCount: due.length,
      cardIds,
      currentIndex: 0,
      reviewedCount: 0,
      truncated: false,
      continuationAvailable: false,
      ratingCounts: emptyRatingCounts(),
      startedAt: nowTimestamp(),
    };
    session.remainingCount = session.cardIds.length;
    sessions.set(id, session);
    return json(res, 201, { session: withModeTag(session), card: sessionCurrentCard(session) });
  }

  const sessionMatch = path.match(/^\/(getReviewSessionHandler|submitSessionReviewHandler|endReviewSessionHandler)\/([^/]+)$/);
  if (sessionMatch) {
    const handler = sessionMatch[1];
    const rawId = decodeURIComponent(sessionMatch[2]);
    const session = sessions.get(rawId);

    if (handler === "getReviewSessionHandler") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      if (!session) return json(res, 404, { error: "Review session not found" });
      session.remainingCount = Math.max(0, session.cardIds.length - session.currentIndex);
      return json(res, 200, { session: withModeTag(session), card: sessionCurrentCard(session) });
    }
    if (handler === "submitSessionReviewHandler") {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!session) return json(res, 404, { error: "Review session not found" });
      const body = await readBody(req).catch((e) => e);
      if (body instanceof Error) return json(res, 400, { error: "Invalid JSON body" });
      const { issues, rating } = validateSessionReview(body);
      if (issues.length) return validationErrorResponse(res, issues);
      if (session.status !== "active") {
        return json(res, 409, { error: `Review session ${rawId} is not active (status: ${session.status})` });
      }
      // Skip cards deleted since the snapshot (bounded by the queue length).
      let targetIndex = -1;
      for (let i = session.currentIndex; i < session.cardIds.length; i += 1) {
        if (cards.has(session.cardIds[i])) {
          targetIndex = i;
          break;
        }
      }
      if (targetIndex < 0) {
        // Every remaining snapshot card was deleted — finish the session.
        session.status = "completed";
        session.endedAt = nowTimestamp();
        session.remainingCount = 0;
        return json(res, 200, { session: withModeTag(session), card: null });
      }
      // Pre-read the next card the session should point at AFTER this rating:
      // scan forward for the first card that still exists (deleted ids are
      // skipped and never count). Mirrors the backend's no-stall behavior.
      let nextIndex = session.cardIds.length;
      for (let i = targetIndex + 1; i < session.cardIds.length; i += 1) {
        if (cards.has(session.cardIds[i])) {
          nextIndex = i;
          break;
        }
      }
      // Apply the simplified FSRS schedule (same helper the review route uses).
      const card = cards.get(session.cardIds[targetIndex]);
      const reviewAt = body.reviewAt !== undefined ? new Date(body.reviewAt) : new Date();
      const reviewWire = {
        _seconds: Math.floor(reviewAt.getTime() / 1000),
        _nanoseconds: (reviewAt.getTime() % 1000) * 1000000,
      };
      const priorState = card.state;
      const priorDue = card.due;
      const logEntry = {
        rating,
        state: priorState,
        review: reviewWire,
        due: priorDue,
        stability: card.stability,
        difficulty: card.difficulty,
        reps: card.reps,
        lapses: card.lapses,
      };
      const dueMinutes = nextDueMinutes(card, rating);
      card.state = nextState(card, rating);
      card.reps += 1;
      if (card.state === 3) card.lapses += 1;
      card.stability = rating === 1 ? Math.max(0.2, card.stability / 2) : (card.stability || 2.3) * 1.4;
      card.difficulty = Math.max(1, Math.min(10, card.difficulty || 5) + (rating === 4 ? -0.5 : rating === 1 ? 0.5 : 0));
      card.due = addMinutes(reviewWire, dueMinutes);
      card.lastReview = reviewWire;
      card.updatedAt = nowTimestamp();
      card.reviewLog = [...card.reviewLog, logEntry];

      // Advance the session atomically-with-the-card (mock is single-threaded).
      session.ratingCounts = bumpRatingCounts(session.ratingCounts, rating);
      session.reviewedCount += 1;
      session.currentIndex = nextIndex;
      session.lastReviewedAt = nowTimestamp();
      if (nextIndex >= session.cardIds.length) {
        session.status = "completed";
        session.endedAt = nowTimestamp();
      }
      session.remainingCount = Math.max(0, session.cardIds.length - nextIndex);
      return json(res, 200, { session: withModeTag(session), card: sessionCurrentCard(session) });
    }
    if (handler === "endReviewSessionHandler") {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      if (!session) return json(res, 404, { error: "Review session not found" });
      if (session.status === "active") {
        session.status = "ended";
        session.endedAt = nowTimestamp();
      }
      session.remainingCount = Math.max(0, session.cardIds.length - session.currentIndex);
      return json(res, 200, withModeTag(session));
    }
  }

  return json(res, 404, { error: `Not found: ${method} ${path}` });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FSRS flashcard mock server listening on http://127.0.0.1:${PORT}`);
  console.log(API_KEY ? "API key auth enabled (X-API-Key header)" : "API key auth disabled (set API_KEY env to enable)");
});
