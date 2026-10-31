import { assembleApkgBytes, buildCollectionBytes, parseApkgImport, type ExportCard } from './apkg';
import { ankiHtmlToPlainText, escapeHtmlText, plainTextToAnkiHtml } from './text';

describe('Anki HTML text conversion', () => {
  it('ignores greater-than characters inside quoted tag attributes', () => {
    expect(ankiHtmlToPlainText('<span title="a > b">hello</span>')).toBe('hello');
    expect(ankiHtmlToPlainText("<span title='a > b'>hello</span>")).toBe('hello');
  });

  it('preserves unterminated tags and decodes escaped markup only after stripping', () => {
    const unterminated = '<span title="unfinished > value';
    expect(ankiHtmlToPlainText(unterminated)).toBe(unterminated);
    expect(ankiHtmlToPlainText('&lt;span title=&quot;a &gt; b&quot;&gt;hello&lt;/span&gt;'))
      .toBe('<span title="a > b">hello</span>');
    expect(ankiHtmlToPlainText('2 < 3 &amp; 4 > 1')).toBe('2 < 3 & 4 > 1');
  });

  it('encodes the Anki field separator after ampersands', () => {
    const separator = String.fromCharCode(31);
    expect(escapeHtmlText(`left${separator}right`)).toBe('left&#31;right');
    expect(plainTextToAnkiHtml(`left${separator}right`)).toBe('left&#31;right');
    expect(plainTextToAnkiHtml('literal &#31;')).toBe('literal &amp;#31;');
  });

  it('round-trips field separators through the real APKG builder and parser', async () => {
    const now = 1_700_000_000_000;
    const separator = String.fromCharCode(31);
    const front = `front${separator}middle and literal &#31;`;
    const back = `back${separator}tail`;
    const card: ExportCard = {
      id: 'field-separator-roundtrip',
      front,
      back,
      deckPath: null,
      tags: [],
      createdAtMs: now,
      updatedAtMs: now,
      dueMs: now,
      state: 0,
      stability: 1,
      difficulty: 5,
      reps: 0,
      lapses: 0,
      reviewLog: [],
    };
    const collection = await buildCollectionBytes([card], now);
    const packageBytes = await assembleApkgBytes(collection, []);
    const imported = await parseApkgImport(packageBytes);

    expect(imported.cards).toHaveLength(1);
    expect(imported.cards[0].front).toBe(front);
    expect(imported.cards[0].back).toBe(back);
  });
});
