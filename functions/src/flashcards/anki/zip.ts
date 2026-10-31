/**
 * Bounded in-memory ZIP reading and writing for Anki .apkg files.
 *
 * Security model (import):
 *  - The archive is decoded from a base64 envelope ONLY after its declared
 *    encoded size was validated by the caller (schema cap), and the DECODED
 *    buffer is size-capped before ZIP parsing. Central-directory sizes are
 *    validated before decompression and extracted output is capped while
 *    inflating, not after materialization.
 *  - Every member is treated as an opaque BLOB: no member name is ever used
 *    as a filesystem path, so a crafted `../../evil` entry cannot traverse
 *    anywhere. Members are keyed by their normalized decoded name.
 *  - Duplicate member names (two RAW entries normalizing to the same key)
 *    are REJECTED — silent last-wins would be a spoofing vector. The
 *    central directory is capped at ANKI_MAX_ZIP_ENTRIES.
 *  - Declared sizes of members to extract must fit the aggregate budget
 *    before inflate; each extraction has a hard per-member and remaining
 *    aggregate output limit.
 *  - No shelling out, no temp files: everything lives in memory.
 */
import JSZip from 'jszip';
import { inflateRawSync } from 'node:zlib';
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

interface CentralEntry {
  rawName: Uint8Array;
  name: string;
  key: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directoryOffset: number;
  entryEndOffset: number;
  directory: boolean;
}

function normalizeName(name: string): string {
  const parts: string[] = [];
  for (const part of name.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function findEndOfCentralDirectory(raw: Uint8Array): number {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const lower = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= lower; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new ApkgFormatError('ZIP end-of-central-directory record is missing or malformed');
}

function readZip64Value(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApkgFormatError('ZIP64 value exceeds safe numeric bounds');
  return Number(value);
}

function parseCentralDirectory(raw: Uint8Array): CentralEntry[] {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const eocd = findEndOfCentralDirectory(raw);
  let disk = buffer.readUInt16LE(eocd + 4);
  let directoryDisk = buffer.readUInt16LE(eocd + 6);
  let diskEntries = buffer.readUInt16LE(eocd + 8);
  let count = buffer.readUInt16LE(eocd + 10);
  let directorySize = buffer.readUInt32LE(eocd + 12);
  let directoryOffset = buffer.readUInt32LE(eocd + 16);
  let directoryEnd = eocd;
  const locatorOffset = eocd - 20;
  if (locatorOffset >= 0 && buffer.readUInt32LE(locatorOffset) === 0x07064b50) {
    if (buffer.readUInt32LE(locatorOffset + 4) !== 0 || buffer.readUInt32LE(locatorOffset + 16) !== 1) {
      throw new ApkgFormatError('Multi-disk ZIP64 archives are not supported');
    }
    const zip64Offset = readZip64Value(buffer, locatorOffset + 8);
    if (zip64Offset > buffer.length || zip64Offset + 56 > locatorOffset || buffer.readUInt32LE(zip64Offset) !== 0x06064b50) {
      throw new ApkgFormatError('Malformed ZIP64 end-of-central-directory record');
    }
    const zip64Size = readZip64Value(buffer, zip64Offset + 4);
    if (zip64Size < 44 || zip64Offset + 12 + zip64Size !== locatorOffset) {
      throw new ApkgFormatError('Malformed ZIP64 end-of-central-directory bounds');
    }
    disk = buffer.readUInt32LE(zip64Offset + 16);
    directoryDisk = buffer.readUInt32LE(zip64Offset + 20);
    diskEntries = readZip64Value(buffer, zip64Offset + 24);
    count = readZip64Value(buffer, zip64Offset + 32);
    directorySize = readZip64Value(buffer, zip64Offset + 40);
    directoryOffset = readZip64Value(buffer, zip64Offset + 48);
    directoryEnd = zip64Offset;
    if ((buffer.readUInt16LE(eocd + 8) !== 0xffff && buffer.readUInt16LE(eocd + 8) !== diskEntries)
      || (buffer.readUInt16LE(eocd + 10) !== 0xffff && buffer.readUInt16LE(eocd + 10) !== count)
      || (buffer.readUInt32LE(eocd + 12) !== 0xffffffff && buffer.readUInt32LE(eocd + 12) !== directorySize)
      || (buffer.readUInt32LE(eocd + 16) !== 0xffffffff && buffer.readUInt32LE(eocd + 16) !== directoryOffset)) {
      throw new ApkgFormatError('ZIP64 end-of-central-directory values disagree with the ZIP record');
    }
  }
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== count) {
    throw new ApkgFormatError('Multi-disk ZIP archives are not supported');
  }
  if (count > ANKI_MAX_ZIP_ENTRIES) {
    throw new ApkgFormatError(`Package declares too many entries (${count} > ${ANKI_MAX_ZIP_ENTRIES})`);
  }
  if (directoryOffset + directorySize !== directoryEnd || directoryEnd > buffer.length) {
    throw new ApkgFormatError('ZIP central directory bounds are invalid');
  }

  const entries: CentralEntry[] = [];
  const claimed = new Map<string, string>();
  let offset = directoryOffset;
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ApkgFormatError('Malformed ZIP central directory entry');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc32 = buffer.readUInt32LE(offset + 16);
    let compressedSize = buffer.readUInt32LE(offset + 20);

    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let diskStart = buffer.readUInt16LE(offset + 34);
    let localOffset = buffer.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd) throw new ApkgFormatError('Malformed ZIP central directory metadata');
    const extraStart = offset + 46 + nameLength;
    const extraEnd = extraStart + extraLength;
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) {
      let zip64Offset = extraStart;
      let zip64End = -1;
      while (zip64Offset + 4 <= extraEnd) {
        const fieldId = buffer.readUInt16LE(zip64Offset);
        const fieldLength = buffer.readUInt16LE(zip64Offset + 2);
        const fieldEnd = zip64Offset + 4 + fieldLength;
        if (fieldEnd > extraEnd) throw new ApkgFormatError('Malformed ZIP extra field');
        if (fieldId === 0x0001) {
          zip64End = fieldEnd;
          let valueOffset = zip64Offset + 4;
          const readField = (): number => {
            if (valueOffset + 8 > zip64End) throw new ApkgFormatError('Truncated ZIP64 extra field');
            const value = readZip64Value(buffer, valueOffset);
            valueOffset += 8;
            return value;
          };
          if (uncompressedSize === 0xffffffff) uncompressedSize = readField();
          if (compressedSize === 0xffffffff) compressedSize = readField();
          if (localOffset === 0xffffffff) localOffset = readField();
          if (diskStart === 0xffff) {
            if (valueOffset + 4 > zip64End) throw new ApkgFormatError('Truncated ZIP64 extra field');
            diskStart = buffer.readUInt32LE(valueOffset);
          }
          break;
        }
        zip64Offset = fieldEnd;
      }
      if (zip64End < 0) throw new ApkgFormatError('ZIP64 member is missing its ZIP64 extra field');
    }
    if (diskStart !== 0) throw new ApkgFormatError('Multi-disk ZIP archives are not supported');
    const rawNameOffset = offset + 46;
    const rawName = buffer.subarray(rawNameOffset, rawNameOffset + nameLength);
    const name = buffer.toString('utf8', rawNameOffset, rawNameOffset + nameLength);
    const key = normalizeName(name);
    if (key === '') throw new ApkgFormatError('ZIP member has an empty name');
    const previous = claimed.get(key);
    if (previous !== undefined) {
      throw new ApkgFormatError(`Duplicate archive member: "${previous}" and "${name}" both map to "${key}"`);
    }
    claimed.set(key, name);
    entries.push({
      rawName,
      name,
      key,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      directoryOffset,
      entryEndOffset: directoryOffset,
      directory: name.endsWith('/') || name.endsWith('\\'),
    });
    offset = recordEnd;
  }
  if (offset !== directoryEnd) throw new ApkgFormatError('ZIP central directory record count/size mismatch');
  const localEntries = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 0; i < localEntries.length; i += 1) {
    const entry = localEntries[i];
    if (entry.localOffset >= directoryOffset || (i > 0 && localEntries[i - 1].localOffset === entry.localOffset)) {
      throw new ApkgFormatError('ZIP local entry offsets overlap or point outside the local data area');
    }
    entry.entryEndOffset = localEntries[i + 1]?.localOffset ?? directoryOffset;
  }
  return entries;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function extractMember(raw: Uint8Array, entry: CentralEntry, maxOutputBytes: number): Uint8Array {
  const buffer = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const offset = entry.localOffset;
  if (offset >= entry.directoryOffset || offset + 30 > entry.directoryOffset || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new ApkgFormatError(`Malformed local header for member "${entry.name}"`);
  }
  const flags = buffer.readUInt16LE(offset + 6);
  const method = buffer.readUInt16LE(offset + 8);
  const localCrc = buffer.readUInt32LE(offset + 14);
  const localCompressed = buffer.readUInt32LE(offset + 18);
  const localUncompressed = buffer.readUInt32LE(offset + 22);
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + nameLength + extraLength;
  const localName = buffer.subarray(offset + 30, offset + 30 + nameLength);
  if (dataOffset > entry.entryEndOffset || flags !== entry.flags || method !== entry.method
    || !localName.equals(entry.rawName)) {
    throw new ApkgFormatError(`Local/central ZIP metadata mismatch for member "${entry.name}"`);
  }
  if ((flags & 0x0001) !== 0 || (flags & ~0x080e) !== 0) {
    throw new ApkgFormatError(`Unsupported ZIP flags for member "${entry.name}"`);
  }
  if (method !== 0 && method !== 8) throw new ApkgFormatError(`Unsupported compression method for member "${entry.name}"`);
  const hasDescriptor = (flags & 0x0008) !== 0;
  if (!hasDescriptor) {
    let localZip64Offset = -1;
    let localZip64End = -1;
    const needsZip64 = localCompressed === 0xffffffff || localUncompressed === 0xffffffff;
    if (needsZip64) {
      let extraOffset = offset + 30 + nameLength;
      while (extraOffset + 4 <= dataOffset) {
        const fieldId = buffer.readUInt16LE(extraOffset);
        const fieldLength = buffer.readUInt16LE(extraOffset + 2);
        const fieldEnd = extraOffset + 4 + fieldLength;
        if (fieldEnd > dataOffset) throw new ApkgFormatError(`Malformed local ZIP extra field for member "${entry.name}"`);
        if (fieldId === 0x0001) {
          if (localZip64Offset >= 0) throw new ApkgFormatError(`Duplicate local ZIP64 extra field for member "${entry.name}"`);
          localZip64Offset = extraOffset + 4;
          localZip64End = fieldEnd;
        }
        extraOffset = fieldEnd;
      }
      if (extraOffset !== dataOffset || localZip64Offset < 0) {
        throw new ApkgFormatError(`Missing or malformed local ZIP64 sizes for member "${entry.name}"`);
      }
    }
    let zip64ValueOffset = localZip64Offset;
    const matchesZip64Size = (expected: number): boolean => {
      if (zip64ValueOffset < 0 || zip64ValueOffset + 8 > localZip64End) {
        throw new ApkgFormatError(`Truncated local ZIP64 sizes for member "${entry.name}"`);
      }
      const actual = readZip64Value(buffer, zip64ValueOffset);
      zip64ValueOffset += 8;
      return actual === expected;
    };
    const localSizesMatch = (localUncompressed === 0xffffffff
      ? matchesZip64Size(entry.uncompressedSize)
      : localUncompressed === entry.uncompressedSize)
      && (localCompressed === 0xffffffff
        ? matchesZip64Size(entry.compressedSize)
        : localCompressed === entry.compressedSize);
    if (localCrc !== entry.crc32 || !localSizesMatch) {
      throw new ApkgFormatError(`Local/central ZIP size or CRC mismatch for member "${entry.name}"`);
    }
  }
  const compressedEnd = dataOffset + entry.compressedSize;
  if (compressedEnd > entry.entryEndOffset) throw new ApkgFormatError(`Truncated or overlapping member "${entry.name}"`);
  if (hasDescriptor) {
    const descriptor = compressedEnd;
    const hasSignature = descriptor + 4 <= entry.entryEndOffset && buffer.readUInt32LE(descriptor) === 0x08074b50;
    const fieldsOffset = descriptor + (hasSignature ? 4 : 0);
    const zip64Descriptor = localCompressed === 0xffffffff || localUncompressed === 0xffffffff;
    const descriptorSize = zip64Descriptor ? 20 : 12;
    if (fieldsOffset + descriptorSize > entry.entryEndOffset || buffer.readUInt32LE(fieldsOffset) !== entry.crc32) {
      throw new ApkgFormatError(`Invalid data descriptor for member "${entry.name}"`);
    }
    const descriptorSizesMatch = zip64Descriptor
      ? readZip64Value(buffer, fieldsOffset + 4) === entry.compressedSize
        && readZip64Value(buffer, fieldsOffset + 12) === entry.uncompressedSize
      : buffer.readUInt32LE(fieldsOffset + 4) === entry.compressedSize
        && buffer.readUInt32LE(fieldsOffset + 8) === entry.uncompressedSize;
    if (!descriptorSizesMatch) throw new ApkgFormatError(`Invalid data descriptor for member "${entry.name}"`);
  }
  const compressed = buffer.subarray(dataOffset, compressedEnd);
  let data: Uint8Array;
  try {
    data = method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(maxOutputBytes, entry.uncompressedSize)) });
  } catch {
    throw new ApkgFormatError(`Cannot safely decompress member "${entry.name}"`);
  }
  if (data.length !== entry.uncompressedSize || data.length > maxOutputBytes) {
    throw new ApkgFormatError(`Member size mismatch or extraction limit exceeded for "${entry.name}"`);
  }
  if (crc32(data) !== entry.crc32) throw new ApkgFormatError(`CRC32 mismatch for member "${entry.name}"`);
  return data;
}

/**
 * Decodes a .apkg ZIP from raw bytes into selected members.
 * Central sizes are checked before bounded extraction; normalized duplicates
 * are rejected rather than silently overwritten.
 */
export async function decodeApkg(
  raw: Uint8Array,
  options: { relevant?: (name: string) => boolean } = {},
): Promise<Map<string, ZipEntry>> {
  if (raw.length === 0) throw new ApkgFormatError('Package is empty');
  if (!isLikelyZip(raw)) throw new ApkgFormatError('Not a valid ZIP package (missing PK signature)');

  let entries: CentralEntry[];
  try {
    entries = parseCentralDirectory(raw);
  } catch (err) {
    if (err instanceof ApkgFormatError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ApkgFormatError(`Cannot open package ZIP: ${message}`);
  }

  const isRelevant = options.relevant ?? (() => true);
  const candidates = entries.filter((entry) => !entry.directory && (isRelevant(entry.name) || isRelevant(entry.key)));
  let declaredTotal = 0;
  for (const entry of candidates) {
    if (entry.compressedSize > raw.length || entry.uncompressedSize > MAX_MEMBER_BYTES) {
      throw new ApkgFormatError(`Package member too large or malformed: ${entry.name}`);
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > ANKI_MAX_ZIP_AGGREGATE_BYTES) {
      throw new ApkgFormatError(
        `Package members declare ${declaredTotal} inflated bytes > ${ANKI_MAX_ZIP_AGGREGATE_BYTES}`,
      );
    }
  }

  const out = new Map<string, ZipEntry>();
  let inflatedTotal = 0;
  for (const entry of candidates) {
    const remaining = ANKI_MAX_ZIP_AGGREGATE_BYTES - inflatedTotal;
    const data = extractMember(raw, entry, Math.min(MAX_MEMBER_BYTES, remaining));
    inflatedTotal += data.length;
    out.set(entry.key, { name: entry.key, data });
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
  maxOutputBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxOutputBytes) && maxOutputBytes !== Number.POSITIVE_INFINITY) {
    throw new ApkgFormatError('Invalid generated ZIP output limit');
  }
  const zip = new JSZip();
  let inputBytes = 0;
  for (const member of members) {
    const data = toUint8(member.data);
    inputBytes += data.byteLength;
    if (inputBytes > maxOutputBytes) throw new ApkgFormatError('ZIP members exceed output size limit');
    zip.file(member.name, data, { binary: true });
  }
  if (mediaJson !== undefined) {
    inputBytes += Buffer.byteLength(mediaJson, 'utf8');
    if (inputBytes > maxOutputBytes) throw new ApkgFormatError('ZIP members exceed output size limit');
    zip.file('media', mediaJson);
  }
  const stream = zip.generateNodeStream({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    streamFiles: true,
  });
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      (stream as unknown as { destroy(): void }).destroy();
      reject(error);
    };
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      if (settled) return;
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += part.byteLength;
      if (total > maxOutputBytes) {
        fail(new ApkgFormatError(`Generated package exceeds output size limit (${total} > ${maxOutputBytes})`));
        return;
      }
      chunks.push(part);
    });
    stream.once('error', fail);
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(Buffer.concat(chunks, total));
      } catch (error) {
        reject(error);
      }
    });
    stream.resume();
  });
}
