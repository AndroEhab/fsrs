/**
 * Anki package (.apkg) import/export — shared limits and wire types.
 *
 * Import reads a standard .apkg: a ZIP archive containing a SQLite
 * `collection.anki2` (the Anki collection schema: `col`, `notes`, `cards`,
 * `revlog`, …). Notes become flashcards; each note's first card's deck is
 * imported (per-card deck assignment beyond the first card is out of scope —
 * a note's cards share one deck in practice and this product has one card
 * per note). Export writes a valid .apkg that stock Anki can import.
 *
 * Content model: this product stores card `front`/`back` as PLAIN TEXT
 * (the MCP review widget renders them with textContent/esc — never HTML).
 * Anki note fields are HTML. Import therefore converts Anki field HTML to
 * plain text with a small, whitelist-based converter (line breaks from
 * `<br>`/`<div>`/`<p>`; list prefixes from `<li>`; all other tags dropped;
 * entities decoded). Export does the inverse: plain text → escaped HTML
 * with `<br>` line breaks, and cloze `[...]` markers are mapped to
 * `{{cN::…}}` cloze markup so cloze cards re-import with working blanks.
 */

/** Imported-card note text maximum (mirrors the flashcard front/back limit). */
export const ANKI_TEXT_MAX = 10_000;

/** Imported-card tag maximum length and per-card count (product limits). */
export const ANKI_TAG_MAX_LENGTH = 50;
export const ANKI_TAG_MAX_COUNT = 30;

/** Imported deck name component limit (product deck-name limit, per level). */
export const ANKI_DECK_NAME_MAX = 100;
/** Imported deck PATH (nested `A::B::C`) maximum length. */
export const ANKI_DECK_PATH_MAX = 300;

/** Hard cap on cards accepted per import (bounded writes + request size). */
export const ANKI_IMPORT_CARD_LIMIT = 1000;
/** Hard cap on cards exported per package (matches the import cap). */
export const ANKI_EXPORT_CARD_LIMIT = 1000;

/**
 * Maximum DECODED .apkg byte size accepted for import. A valid minimal
 * package is a few KB; real decks with embedded media run to tens of MB.
 * 20 MiB bounds extraction memory while accepting normal decks; media
 * beyond the embed budget is skipped (import never stores media bytes —
 * this product stores no image bytes in Firestore, and card `images` are
 * URL references only).
 */
export const ANKI_MAX_APKG_BYTES = 20 * 1024 * 1024;

/**
 * Maximum single media member size embedded during EXPORT (bytes). Larger
 * images (this product allows cloud uploads up to 10 MiB per image but only
 * references them by signed URL) cannot be embedded — they are skipped and
 * reported in `mediaSkipped`.
 */
export const ANKI_MAX_MEDIA_BYTES = 4 * 1024 * 1024;

/** Media bytes embedded per exported package are capped overall (memory). */
export const ANKI_MAX_TOTAL_MEDIA_BYTES = 8 * 1024 * 1024;

/** Maximum media files embedded per exported package. */
export const ANKI_MAX_MEDIA_COUNT = 100;

/**
 * The package "deck" that deck-less cards import into (export side: cards
 * with no deck are exported under this name).
 */
export const ANKI_DEFAULT_DECK = 'Imported';

/**
 * Maximum members a ZIP may declare (bounds the central-directory parse).
 * Real .apkg files have a handful; hostile archives can declare millions.
 */
export const ANKI_MAX_ZIP_ENTRIES = 512;
/** Maximum bytes of a single ZIP member read into memory (SQLite db cap). */
export const ANKI_MAX_MEMBER_BYTES = 20 * 1024 * 1024;
/**
 * Maximum AGGREGATE inflated bytes across every member actually extracted
 * from one .apkg ZIP (zip-bomb bound). 40 MiB comfortably fits a real
 * collection.anki2 (the only member import inflates) plus media maps, while
 * capping hostile multi-member decompression well below GCF memory.
 */
export const ANKI_MAX_ZIP_AGGREGATE_BYTES = 40 * 1024 * 1024;

/** One resolved card to write during import (validated, normalized). */
export interface ImportedCard {
  /** Front text (product plain-text form, after HTML→text conversion). */
  front: string;
  /** Back text. */
  back: string;
  /** Deck path as imported (`null`/absent when the note had no deck). */
  deckPath: string | null;
  /** Tags (validated; at most ANKI_TAG_MAX_COUNT entries). */
  tags: string[];
}

/** Result of parsing + validating one .apkg payload. */
export interface ParsedApkgImport {
  /** Cards in deterministic note-id order (deduplicated by note guid). */
  cards: ImportedCard[];
  /** Notes skipped because their card count was not 1. */
  skippedNotes: number;
  /** Notes skipped because a required field was empty. */
  skippedEmpty: number;
}

/** Import request body (base64 envelope). */
export interface ImportApkgInput {
  /** Base64 (standard alphabet) encoding of the whole .apkg ZIP. */
  package: string;
  /** When set, every imported card is assigned to this deck (path form). */
  deckPath?: string;
}

/** Import response: summary + deterministic write report. */
export interface ImportApkgResponse {
  /** Cards actually created (front/back/deck/tags). */
  cards: ImportedCard[];
  /** Number of notes skipped because they had other than one card. */
  skippedNotes: number;
  /** Number of notes skipped because a field was empty after conversion. */
  skippedEmpty: number;
  /** Notes skipped because the package exceeded the card cap. */
  skippedOverLimit: number;
  /** True when every card committed in one batch (see `batchCount`). */
  atomic: boolean;
  /** Number of Firestore write batches used (>1 only when over 500 cards). */
  batchCount: number;
}

/** Media member exported into a package (ZIP name = its media.json index). */
export interface ExportedMedia {
  /** File name stored in `media` (basename). */
  fileName: string;
  /** Decoded bytes. */
  data: Uint8Array;
  /** Source URL for reporting. */
  sourceUrl: string;
}

/** Result of building one exported .apkg. */
export interface BuiltApkg {
  /** The ZIP bytes (no base64). */
  bytes: Uint8Array;
  /** Card count actually exported. */
  cardCount: number;
  /** Number of cards excluded by the caller's deck/count selection. */
  filteredCards: number;
  /** Deck names included in the export (`null` = deck-less cards). */
  decks: Array<string | null>;
  /** Media files embedded. */
  media: ExportedMedia[];
  /** Source image URLs that could not be embedded (too large/not http). */
  mediaSkipped: Array<{ url: string; reason: string }>;
  /** True when exported scheduling fields (where Anki-compatible). */
  schedulingExported: boolean;
}

/** Export request body. */
export interface ExportApkgInput {
  /** Optional deck filter (deck name or nested path; exact match). */
  deck?: string;
  /** Optional id filter. */
  cardIds?: string[];
}

/** Export response. */
export interface ExportApkgResponse {
  /** Base64 (standard alphabet) encoding of the .apkg ZIP. */
  package: string;
  /** Cards exported. */
  cardCount: number;
  /** Cards excluded by the selection (total minus exported). */
  filteredCards: number;
  /** Decks represented in the package. */
  decks: Array<string | null>;
  /** Embedded media files (name → bytes available in the package). */
  media: Array<{ fileName: string; sourceUrl: string }>;
  /** Image URLs skipped and why. */
  mediaSkipped: Array<{ url: string; reason: string }>;
  /** True when scheduling metadata was carried where Anki-compatible. */
  schedulingExported: boolean;
}
