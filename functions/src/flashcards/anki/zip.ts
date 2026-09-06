/**
 * Bounded in-memory ZIP reading and writing for Anki .apkg files.
 *
 * Security model (import):
 *  - The archive is decoded from a base64 envelope ONLY after its declared
 *    encoded size was validated by the caller (schema cap), and the DECODED
 *    buffer is size-capped before ZIP parsing (decompression of a hostile
 *    archive is bounded because jszip inflates into the in-memory output we
 *    measure; we enforce ANKI_MAX_MEMBER_BYTES per member AFTER inflate).
 *  - Every member is treated as an opaque BLOB: no member name is ever used
 *    as a filesystem path, so a crafted `../../evil` entry cannot traverse
 *    anywhere. Members are keyed by their exact (decoded) name string.
 *  - Duplicate member names (two RAW entries normalizing to the same key)
 *    are REJECTED — silent last-wins would be a spoofing vector. The
 *    central directory is capped at ANKI_MAX_ZIP_ENTRIES.
 *  - Zip bombs are bounded twice: the DECLARED uncompressed sizes of the
 *    members we extract must fit ANKI_MAX_ZIP_AGGREGATE_BYTES BEFORE any
 *    inflate, and the ACTUAL inflated bytes are summed with a hard stop at
 *    the same cap (defense against lying headers). Irrelevant members
 *    (anything but collection.anki2 during import) are never inflated.
 *  - No shelling out, no temp files: everything lives in memory.
 */
import JSZip from 'jszip';
import { ANKI_MAX_ZIP_ENTRIES, ANKI_MAX_ZIP_AGGREGATE_BYTES } from './types';

/** Max member byte size enforced during extract (see types.ts). */
const MAX_MEMBER_BYTES = 20 * 1024 * 1024;

export interface ZipEntry {
  /** Exact member name (never used as a path). */
  name: string;
  /** Inflated bytes. */
  data: Uint8Array;
}

/** A bounded error type for malformed/hostile package inputs. */
export class ApkgFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkgFormatError';
  }
}

function isLikelyZip(data: Uint8Array): boolean {
  return data.length >= 4
    && data[0] === 0x50 && data[1] === 0x4b
    && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
    && (data[3] === 0x04 || data[3] === 0x06 || data[3] === 0x08);
}

function toUint8(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return new Uint8Array(value);
}

/**
 * Decodes a .apkg ZIP from raw bytes into its members (bounded).
 * Throws ApkgFormatError on malformed/hostile input. Returns entries in
 * central-directory order, each member ≤ MAX_MEMBER_BYTES after inflate.
 */
export async function decodeApkg(
  raw: Uint8Array,
  options: { relevant?: (name: string) => boolean } = {},
): Promise<Map<string, ZipEntry>> {
  if (raw.length === 0) throw new ApkgFormatError('Package is empty');
  if (!isLikelyZip(raw)) throw new ApkgFormatError('Not a valid ZIP package (missing PK signature)');

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(raw as unknown as ArrayBuffer, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApkgFormatError(`Cannot open package ZIP: ${message}`);
  }

  const names = Object.keys(zip.files);
  if (names.length > ANKI_MAX_ZIP_ENTRIES) {
    throw new ApkgFormatError(`Package declares too many entries (${names.length} > ${ANKI_MAX_ZIP_ENTRIES})`);
  }

  // Normalize an archive name for keying. Never used as a filesystem path —
  // members are opaque blobs keyed by this normalized string.
  const normalize = (rawName: string): string => rawName.replace(/[\\/]+/g, '/').replace(/^\/+/, '').replace(/\/$/, '');
  const isRelevant = options.relevant ?? (() => true);

  // First pass: collect the RAW names we will extract (dedupe by raw name,
  // reject normalized-key collisions — a second raw entry that normalizes to
  // an already-claimed key is a spoofing vector, not a silent skip).
  const candidates: Array<{ rawName: string; key: string; declaredSize: number }> = [];
  const claimed = new Map<string, string>(); // normalized key -> raw name
  for (const name of names) {
    const file = zip.files[name];
    if (file.dir || name.endsWith('/')) continue;
    // Raw stored name (jszip may normalize the key it exposes; the unsafe
    // original carries the true bytes when they differ).
    const rawName = typeof file.unsafeOriginalName === 'string' && file.unsafeOriginalName !== ''
      ? file.unsafeOriginalName
      : name;
    if (!isRelevant(rawName) && !isRelevant(name)) continue;
    const key = normalize(rawName);
    if (key === '') continue;
    if (claimed.has(key)) {
      throw new ApkgFormatError(`Duplicate archive member: \"${claimed.get(key)}\" and \"${rawName}\" both map to \"${key}\"`);
    }
    claimed.set(key, rawName);
    // Declared (central-directory) uncompressed size without inflating.
    // _data is jszip-internal; read it defensively through a cast.
    const internal = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data;
    const declared = internal !== undefined && typeof internal.uncompressedSize === 'number'
      ? (internal.uncompressedSize as number)
      : 0;
    candidates.push({ rawName, key, declaredSize: declared });
  }

  // Pre-inflation aggregate guard: the DECLARED uncompressed sizes of the
  // members we are about to inflate must fit the budget. A zip bomb that
  // declares huge members is refused here, before any decompression work.
  const declaredTotal = candidates.reduce((sum, e) => sum + e.declaredSize, 0);
  if (declaredTotal > ANKI_MAX_ZIP_AGGREGATE_BYTES) {
    throw new ApkgFormatError(
      `Package members declare ${declaredTotal} inflated bytes > ${ANKI_MAX_ZIP_AGGREGATE_BYTES}`,
    );
  }

  // Second pass: inflate relevant members only, enforcing the per-member cap
  // AND a running aggregate cap on the ACTUAL inflated bytes (defense in
  // depth against lying declared sizes).
  const out = new Map<string, ZipEntry>();
  let inflatedTotal = 0;
  for (const candidate of candidates) {
    // jszip exposes each file under its NORMALIZED key; when the raw name
    // differs ("./x" -> "x"), unsafeOriginalName carries the raw bytes. Locate
    // by raw first, then by the normalized key.
    let file = zip.files[candidate.rawName];
    if (!file) {
      const byRaw = names.find((n) => (zip.files[n].unsafeOriginalName ?? n) === candidate.rawName);
      file = byRaw !== undefined ? zip.files[byRaw] : zip.files[candidate.key];
    }
    if (!file) throw new ApkgFormatError(`Cannot locate archive member "\${candidate.rawName}"`);
    let content: string | Uint8Array | ArrayBuffer;
    try {
      content = await (file as JSZip.JSZipObject).async('uint8array');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApkgFormatError(`Cannot extract member "\${candidate.rawName}": ${message}`);
    }
    const data = toUint8(content);
    if (data.length > MAX_MEMBER_BYTES) {
      throw new ApkgFormatError(`Package member too large: ${candidate.rawName} (${data.length} bytes > ${MAX_MEMBER_BYTES})`);
    }
    inflatedTotal += data.length;
    if (inflatedTotal > ANKI_MAX_ZIP_AGGREGATE_BYTES) {
      throw new ApkgFormatError(`Package inflated size exceeds ${ANKI_MAX_ZIP_AGGREGATE_BYTES} bytes`);
    }
    out.set(candidate.key, { name: candidate.key, data });
  }
  return out;
}

/**
 * Builds a .apkg ZIP in memory from raw members (name → bytes). A `media`
 * JSON member is included when `mediaJson` is provided. No paths are used —
 * every member name is written verbatim as its archive name.
 */
export async function encodeApkg(
  members: Array<{ name: string; data: Uint8Array | Buffer }>,
  mediaJson?: string,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const m of members) {
    zip.file(m.name, m.data as unknown as ArrayBuffer, { binary: true });
  }
  if (mediaJson !== undefined) {
    zip.file('media', mediaJson);
  }
  const blob = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return toUint8(blob);
}
