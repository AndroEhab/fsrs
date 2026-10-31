import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getFirestore } from 'firebase-admin/firestore';
import { decodeApkg } from './zip';
import { ApkgExportError, exportApkg } from './service';
import { refreshOwnedCardImageUrls } from '../service';
import { safeMediaFetch } from './ssrf';
import { MAX_IMAGE_URL_LENGTH } from '../types';
import { ANKI_MAX_APKG_RESPONSE_BYTES } from './types';

jest.mock('../decks', () => ({
  getOrCreateOwnedDeck: jest.fn(),
  readOwnedDeckInTransaction: jest.fn(),
}));
jest.mock('../service', () => ({
  refreshOwnedCardImageUrls: jest.fn(async (input: { images: unknown[] }) => ({ images: input.images })),
}));
jest.mock('./ssrf', () => ({ safeMediaFetch: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toDate: () => new Date(), toMillis: () => Date.now() })),
    fromDate: jest.fn((date: Date) => ({ toDate: () => date, toMillis: () => date.getTime() })),
    fromMillis: jest.fn((ms: number) => ({ toDate: () => new Date(ms), toMillis: () => ms })),
  },
  FieldPath: { documentId: jest.fn(() => '__name__') },
}));

const OWNER = 'media-export-owner';

function createCard(id: string, front: string, urls: string[], createdAtMs: number) {
  return {
    id,
    ownerId: OWNER,
    front,
    back: '',
    deck: null,
    tags: [],
    createdAt: { toMillis: () => createdAtMs },
    updatedAt: { toMillis: () => createdAtMs },
    due: { toMillis: () => createdAtMs },
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    reviewLog: [],
    images: urls.map((url, index) => ({
      id: `${id}-image-${index}`,
      url,
      mimeType: 'image/png',
      addedAt: { toMillis: () => createdAtMs },
    })),
  };
}
function deterministicMediaBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function unicodeImageUrl(index: number): string {
  const prefix = 'https://example.com/';
  const suffix = '.png';
  const token = `u${index.toString(36)}-`;
  return `${prefix}${token}${'界'.repeat(MAX_IMAGE_URL_LENGTH - prefix.length - token.length - suffix.length)}${suffix}`;
}


const cardDocuments = new Map<string, ReturnType<typeof createCard>>();
const mockFirestore = {
  collection: jest.fn(() => ({
    doc: jest.fn((id: string) => ({
      get: jest.fn(async () => {
        const data = cardDocuments.get(id);
        return data === undefined
          ? { id, exists: false, data: () => undefined }
          : { id, exists: true, data: () => data };
      }),
    })),
  })),
};

function installCards(cards: ReturnType<typeof createCard>[]): void {
  cardDocuments.clear();
  for (const card of cards) cardDocuments.set(card.id, card);
}

async function readExportedNotes(packageBase64: string): Promise<Array<{ front: string; flds: string }>> {
  const entries = await decodeApkg(Buffer.from(packageBase64, 'base64'));
  const collection = entries.get('collection.anki2');
  if (!collection) throw new Error('export omitted collection.anki2');
  const dir = mkdtempSync(join(tmpdir(), 'anki-media-export-'));
  const path = join(dir, 'collection.anki2');
  writeFileSync(path, collection.data);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT sfld AS front, flds FROM notes ORDER BY sfld').all() as Array<{ front: string; flds: string }>;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function noteImageSource(flds: string): string | null {
  return /^<img src="([^"]+)">$/.exec(flds)?.[1] ?? null;
}

function mediaIndexForFile(mediaMap: Record<string, string>, fileName: string): string {
  const match = Object.entries(mediaMap).find(([, name]) => name === fileName);
  if (!match) throw new Error(`media manifest does not reference ${fileName}`);
  return match[0];
}

describe('Anki export media collector budgets and filenames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    (getFirestore as jest.Mock).mockReturnValue(mockFirestore);
    cardDocuments.clear();
  });

  afterEach(() => jest.restoreAllMocks());

  it('generates distinct safe names for case-folded reserved basenames and keeps per-card bytes attached', async () => {
    const firstUrl = 'https://images-a.example/CON.png';
    const secondUrl = 'https://images-b.example/con.png';
    installCards([
      createCard('first', 'A', [firstUrl], 1_699_999_999_000),
      createCard('second', 'B', [secondUrl], 1_699_999_999_001),
    ]);
    (safeMediaFetch as jest.Mock).mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      bytes: new Uint8Array(url === firstUrl ? [1, 2] : [3, 4]),
    }));

    const result = await exportApkg({ cardIds: ['first', 'second'] }, OWNER);
    const entries = await decodeApkg(Buffer.from(result.package, 'base64'));
    const mediaMap = JSON.parse(Buffer.from(entries.get('media')!.data).toString('utf8')) as Record<string, string>;
    const fileNames = Object.values(mediaMap);
    expect(fileNames).toHaveLength(2);
    expect(new Set(fileNames.map((name) => name.toLowerCase())).size).toBe(fileNames.length);
    const windowsReservedNames = new Set([
      'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
      ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
      ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
    ]);
    for (const fileName of fileNames) {
      expect(fileName).not.toMatch(/[<>:"/\\|?*]/);
      expect(fileName).not.toMatch(/[. ]$/);
      expect(fileName.split(/[\\/]/)).toHaveLength(1);
      expect(windowsReservedNames.has(fileName.replace(/\.[^.]*$/, '').toUpperCase())).toBe(false);
    }

    const notes = await readExportedNotes(result.package);
    const firstName = noteImageSource(notes.find((note) => note.front === 'A')!.flds.split('\x1f')[1]);
    const secondName = noteImageSource(notes.find((note) => note.front === 'B')!.flds.split('\x1f')[1]);
    expect(firstName).not.toBeNull();
    expect(secondName).not.toBeNull();
    expect(fileNames).toContain(firstName);
    expect(fileNames).toContain(secondName);
    expect(firstName).not.toBe(secondName);
    expect([...entries.get(mediaIndexForFile(mediaMap, firstName!))!.data]).toEqual([1, 2]);
    expect([...entries.get(mediaIndexForFile(mediaMap, secondName!))!.data]).toEqual([3, 4]);
  });

  it('does not sign or fetch after the deadline, but reuses already embedded URL associations', async () => {
    const existingUrl = 'https://images.example/shared.png';
    const skippedUrl = 'https://images.example/not-fetched.png';
    const start = 1_700_000_000_000;
    let nowMs = start;
    (Date.now as jest.Mock).mockImplementation(() => nowMs);
    installCards([
      createCard('first', 'A', [existingUrl], start - 1000),
      createCard('reuse', 'B', [existingUrl], start - 999),
      createCard('skipped', 'C', [skippedUrl], start - 998),
    ]);
    (safeMediaFetch as jest.Mock).mockImplementation(async () => {
      nowMs = start + 8001;
      return { ok: true, status: 200, bytes: new Uint8Array([7, 8]) };
    });

    const result = await exportApkg({ cardIds: ['first', 'reuse', 'skipped'] }, OWNER);
    expect(safeMediaFetch).toHaveBeenCalledTimes(1);
    expect((safeMediaFetch as jest.Mock).mock.calls.map(([url]) => url)).not.toContain(skippedUrl);
    expect(refreshOwnedCardImageUrls).toHaveBeenCalledTimes(1);
    const entries = await decodeApkg(Buffer.from(result.package, 'base64'));
    const mediaMap = JSON.parse(Buffer.from(entries.get('media')!.data).toString('utf8')) as Record<string, string>;
    const [embeddedFileName] = Object.values(mediaMap);
    expect(Object.values(mediaMap)).toHaveLength(1);
    const notes = await readExportedNotes(result.package);
    expect(notes.map((note) => noteImageSource(note.flds.split('\x1f')[1] ?? '')))
      .toEqual([embeddedFileName, embeddedFileName, null]);
  });
  it('debits the shared byte allowance for failed fetches before signing later cards', async () => {
    const embeddedUrl = 'https://images.example/embedded.png';
    const failedUrls = ['https://images.example/fail-one.png', 'https://images.example/fail-two.png'];
    const skippedUrl = 'https://images.example/after-budget.png';
    const start = 1_700_000_000_000;
    installCards([
      createCard('embedded', 'A', [embeddedUrl], start - 1000),
      createCard('failed-one', 'B', [failedUrls[0]], start - 999),
      createCard('failed-two', 'C', [failedUrls[1]], start - 998),
      createCard('reuse', 'D', [embeddedUrl], start - 997),
      createCard('skipped', 'E', [skippedUrl], start - 996),
    ]);
    (safeMediaFetch as jest.Mock).mockImplementation(async (url: string) => (
      url === embeddedUrl
        ? { ok: true, status: 200, bytes: new Uint8Array([1]) }
        : { ok: false, reason: 'fetch failed' }
    ));

    const result = await exportApkg(
      { cardIds: ['embedded', 'failed-one', 'failed-two', 'reuse', 'skipped'] },
      OWNER,
    );
    expect(safeMediaFetch).toHaveBeenCalledTimes(3);
    expect((safeMediaFetch as jest.Mock).mock.calls.map(([url]) => url)).not.toContain(skippedUrl);
    expect(refreshOwnedCardImageUrls).toHaveBeenCalledTimes(3);
    expect(result.mediaSkipped.map((item) => item.url)).toContain(skippedUrl);
    const notes = await readExportedNotes(result.package);
    const imageSources = notes.map((note) => noteImageSource(note.flds.split('\x1f')[1] ?? ''));
    expect(imageSources.map(Boolean)).toEqual([true, false, false, true, false]);
    expect(imageSources[0]).toBe(imageSources[3]);
    expect(imageSources[4]).toBeNull();
  });

  it('does not refresh or fetch after the media count cap while reusing known files', async () => {
    const start = 1_700_000_000_000;
    const cards = Array.from({ length: 101 }, (_, index) => createCard(
      `card-${index}`,
      `Front ${index}`,
      [`https://images.example/image-${index}.png`],
      start - 2000 + index,
    ));
    installCards(cards);
    (safeMediaFetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      bytes: new Uint8Array([9]),
    });

    const cardIds = cards.map((card) => card.id);
    const result = await exportApkg({ cardIds }, OWNER);
    expect(result.media).toHaveLength(100);
    expect(safeMediaFetch).toHaveBeenCalledTimes(100);
    expect((safeMediaFetch as jest.Mock).mock.calls.map(([url]) => url)).not.toContain(cards[100].images[0].url);
    expect(refreshOwnedCardImageUrls).toHaveBeenCalledTimes(100);
    expect(result.mediaSkipped.map((item) => item.url)).toContain(cards[100].images[0].url);
    const notes = await readExportedNotes(result.package);
    const skippedNote = notes.find((note) => note.front === 'Front 100');
    expect(noteImageSource(skippedNote!.flds.split('\x1f')[1] ?? '')).toBeNull();
  });
  it('returns a complete under-limit JSON response with valid package media references', async () => {
    const url = 'https://example.com/bounded.png';
    installCards([createCard('bounded', 'Question', [url], 1_699_999_999_000)]);
    (safeMediaFetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      bytes: new Uint8Array([1, 2, 3]),
    });

    const result = await exportApkg({ cardIds: ['bounded'] }, OWNER);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(ANKI_MAX_APKG_RESPONSE_BYTES);

    const entries = await decodeApkg(Buffer.from(result.package, 'base64'));
    const mediaMap = JSON.parse(Buffer.from(entries.get('media')!.data).toString('utf8')) as Record<string, string>;
    const fileName = result.media[0].fileName;
    const notes = await readExportedNotes(result.package);
    expect(result.cardCount).toBe(1);
    expect(result.media).toHaveLength(1);
    expect(Object.values(mediaMap)).toContain(fileName);
    expect(noteImageSource(notes[0].flds.split('\x1f')[1] ?? '')).toBe(fileName);
    expect(entries.get(mediaIndexForFile(mediaMap, fileName))?.data.byteLength).toBe(3);
  });

  it('rejects an export whose skipped image metadata exceeds the JSON response budget', async () => {
    const firstUrl = 'https://example.com/first.png';
    const secondUrl = 'https://example.org/second.png';
    const unicodeUrls = Array.from({ length: 4998 }, (_, index) => unicodeImageUrl(index));
    const cards = [
      createCard('card-0', 'Question', [firstUrl, secondUrl, ...unicodeUrls.slice(0, 3)], 1_699_999_999_000),
      ...Array.from({ length: 999 }, (_, index) => createCard(
        `card-${index + 1}`,
        `Question ${index + 1}`,
        unicodeUrls.slice(3 + index * 5, 3 + (index + 1) * 5),
        1_699_999_999_000 - index - 1,
      )),
    ];
    installCards(cards);
    const largeImages = new Map([
      [firstUrl, deterministicMediaBytes(4 * 1024 * 1024, 0x12345678)],
      [secondUrl, deterministicMediaBytes(4 * 1024 * 1024, 0x9abcdef0)],
    ]);
    (safeMediaFetch as jest.Mock).mockImplementation(async (url: string) => {
      const bytes = largeImages.get(url);
      if (!bytes) throw new Error();
      return { ok: true, status: 200, bytes };
    });

    await expect(exportApkg(
      { cardIds: cards.map((card) => card.id) },
      OWNER,
    )).rejects.toBeInstanceOf(ApkgExportError);
  });
});
