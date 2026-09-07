/**
 * SSRF guard + pinned fetch for the export media path.
 *
 * `exportApkg` embeds stored card images by fetching their URLs. Those URLs
 * are USER-CONTROLLED: `attachImage` stores an arbitrary http(s) URL, and
 * `uploadImage` stores a Firebase Storage signed download URL. A naive
 * server-side fetch is an SSRF hole: a card image URL could point at the GCP
 * metadata service (169.254.169.254), localhost, a private subnet, or an
 * attacker domain that resolves to one (DNS rebinding). Redirects compound
 * it: fetch() auto-follows up to 20 hops, so a PUBLIC https URL can 3xx to a
 * private target and be fetched.
 *
 * Defense (this module):
 *  1. https-only for server fetches — plaintext http is never fetched.
 *  2. DNS PINNING: hostnames are resolved once via
 *     `dns.lookup(..., { all: true, verbatim: true })` and EVERY answer must
 *     be a public address; the connection is made with a custom `lookup`
 *     that hands Node ONLY the validated public addresses, so the socket
 *     cannot re-resolve to a private IP between check and connect (no
 *     TOCTOU). Literal IP hosts are classified directly.
 *  3. REDIRECTS ARE NOT AUTO-FOLLOWED TO ARBITRARY TARGETS: each 3xx is
 *     inspected; the Location is re-validated (https + public pinning) and
 *     only then followed, with a small hop cap. A redirect to a private/
 *     link-local/metadata/loopback address or to plaintext http is refused.
 *
 * The fetch uses node:https (built-in) with a bounded body read and timeout;
 * no native dependencies, no shelling out. Public external https images
 * (e.g. a CDN, Firebase Storage signed URLs) keep working.
 */
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import { request as httpsRequest } from 'node:https';

const lookupAll = promisify(lookup);

/** IPv4 private/special ranges that a server-side fetch must never target. */
const BLOCKED_V4_RANGES: Array<{ label: string; start: number; end: number }> = [
  { label: 'this network', start: 0x00000000, end: 0x00ffffff },        // 0.0.0.0/8
  { label: 'private (10/8)', start: 0x0a000000, end: 0x0affffff },      // 10.0.0.0/8
  { label: 'CGNAT (100.64/10)', start: 0x64400000, end: 0x647fffff },   // 100.64.0.0/10
  { label: 'loopback (127/8)', start: 0x7f000000, end: 0x7fffffff },    // 127.0.0.0/8
  { label: 'link-local (169.254/16)', start: 0xa9fe0000, end: 0xa9feffff }, // 169.254.0.0/16 (GCP metadata 169.254.169.254)
  { label: 'private (172.16/12)', start: 0xac100000, end: 0xac1fffff }, // 172.16.0.0/12
  { label: 'benchmarking (198.18/15)', start: 0xc6120000, end: 0xc613ffff }, // 198.18.0.0/15
  { label: 'private (192.168/16)', start: 0xc0a80000, end: 0xc0a8ffff },// 192.168.0.0/16
  { label: 'IETF (192.0.0/24)', start: 0xc0000000, end: 0xc00000ff },   // 192.0.0.0/24
  { label: 'TEST-NET-1 (192.0.2/24)', start: 0xc0000200, end: 0xc00002ff },
  { label: 'TEST-NET-2 (198.51.100/24)', start: 0xc6336400, end: 0xc63364ff },
  { label: 'TEST-NET-3 (203.0.113/24)', start: 0xcb007100, end: 0xcb0071ff },
  { label: 'multicast (224/4)', start: 0xe0000000, end: 0xefffffff },   // 224.0.0.0/4
  { label: 'reserved (240/4)', start: 0xf0000000, end: 0xffffffff },    // 240.0.0.0/4 (incl. 255.255.255.255)
];

/**
 * Classifies one IPv4 address string as fetchable ('public') or blocked.
 * Pure; exported for tests. Accepts dotted-quad (and rejects garbage).
 */
export function classifyIpv4(address: string): 'public' | { reason: string } {
  const parts = address.split('.');
  if (parts.length !== 4) return { reason: `unparseable IPv4: ${address}` };
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return { reason: `unparseable IPv4: ${address}` };
    const octet = Number(part);
    if (octet > 255) return { reason: `unparseable IPv4: ${address}` };
    value = (((value << 8) >>> 0) | octet) >>> 0; // keep the 32-bit word unsigned
  }
  for (const range of BLOCKED_V4_RANGES) {
    if (value >= range.start && value <= range.end) {
      return { reason: `blocked address (${range.label})` };
    }
  }
  return 'public';
}

/** Expands an IPv6 address into 8 hex groups (lowercase, no compression). */
function expandIpv6(address: string): string[] | null {
  let head = address;
  let tail = '';
  const doubleColon = address.indexOf('::');
  if (doubleColon >= 0) {
    head = address.slice(0, doubleColon);
    tail = address.slice(doubleColon + 2);
  }
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  // A dotted-quad tail (::ffff:8.8.8.8) is the LAST two groups as IPv4.
  const last = tailGroups[tailGroups.length - 1];
  if (last !== undefined && /^\d{1,3}(\.\d{1,3}){3}$/.test(last)) {
    const octets = last.split('.').map(Number);
    if (octets.some((o) => o > 255)) return null;
    tailGroups[tailGroups.length - 1] = (((octets[0] << 8) >>> 0 | octets[1]) >>> 0).toString(16);
    tailGroups.push((((octets[2] << 8) >>> 0 | octets[3]) >>> 0).toString(16));
  }
  const total = headGroups.length + tailGroups.length;
  if (total > 7) return null;
  const missing = 8 - total;
  const groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  const out: string[] = [];
  for (const g of groups) {
    if (g === '' || !/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(g.toLowerCase().padStart(4, '0'));
  }
  return out;
}

/** A /N prefix (16-bit groups, first `prefixLen/16` full + one partial). */
function matchesPrefix(groups: string[], prefixGroups: string[], prefixBits: number): boolean {
  const full = Math.floor(prefixBits / 16);
  const rem = prefixBits % 16;
  for (let i = 0; i < full; i++) {
    if (groups[i] !== prefixGroups[i]) return false;
  }
  if (rem === 0) return true;
  const mask = 0xffff << (16 - rem);
  const a = Number.parseInt(groups[full], 16);
  const b = Number.parseInt(prefixGroups[full], 16);
  return (a & mask) === (b & mask);
}

const P = (h1: string, h2: string, h3: string, h4: string, h5: string, h6: string, h7: string, h8: string): string[] =>
  [h1, h2, h3, h4, h5, h6, h7, h8].map((h) => h.padStart(4, '0'));

/** IPv6 blocked prefixes (bits, groups). */
const BLOCKED_V6_PREFIXES: Array<{ label: string; groups: string[]; bits: number }> = [
  { label: 'unspecified (::/128)', groups: P('0', '0', '0', '0', '0', '0', '0', '0'), bits: 128 },
  { label: 'loopback (::1/128)', groups: P('0', '0', '0', '0', '0', '0', '0', '1'), bits: 128 },
  { label: 'IPv4-mapped (::ffff:0:0/96)', groups: P('0', '0', '0', '0', '0', 'ffff', '0', '0'), bits: 96 },
  { label: 'NAT64 (64:ff9b::/96)', groups: P('64', 'ff9b', '0', '0', '0', '0', '0', '0'), bits: 96 },
  { label: 'discard-only (100::/64)', groups: P('100', '0', '0', '0', '0', '0', '0', '0'), bits: 64 },
  { label: 'documentation (2001:db8::/32)', groups: P('2001', 'db8', '0', '0', '0', '0', '0', '0'), bits: 32 },
  { label: 'ULA (fc00::/7)', groups: P('fc00', '0', '0', '0', '0', '0', '0', '0'), bits: 7 },
  { label: 'link-local (fe80::/10)', groups: P('fe80', '0', '0', '0', '0', '0', '0', '0'), bits: 10 },
  { label: 'multicast (ff00::/8)', groups: P('ff00', '0', '0', '0', '0', '0', '0', '0'), bits: 8 },
];

/** Extracts an embedded IPv4 from ::ffff:a.b.c.d / 64:ff9b::a.b.c.d forms. */
function embeddedIpv4(groups: string[]): string | null {
  if (groups.length !== 8) return null;
  const last = groups[7];
  const second = groups[6];
  if (second.length !== 4 || last.length !== 4) return null;
  const isMapped = groups[0] === '0000' && groups[1] === '0000' && groups[2] === '0000'
    && groups[3] === '0000' && groups[4] === '0000' && groups[5] === 'ffff';
  const isNat64 = groups[0] === '0064' && groups[1] === 'ff9b' && groups[2] === '0000'
    && groups[3] === '0000' && groups[4] === '0000' && groups[5] === '0000';
  if (!isMapped && !isNat64) return null;
  const hi = Number.parseInt(second, 16);
  const lo = Number.parseInt(last, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Classifies one IPv6 address string as fetchable ('public') or blocked.
 * Pure; exported for tests. IPv4-mapped / NAT64 forms are re-checked as IPv4.
 */
export function classifyIpv6(address: string): 'public' | { reason: string } {
  const groups = expandIpv6(address);
  if (groups === null) return { reason: `unparseable IPv6: ${address}` };
  const embedded = embeddedIpv4(groups);
  if (embedded !== null) {
    const verdict = classifyIpv4(embedded);
    if (verdict !== 'public') {
      return { reason: `blocked address (${(verdict as { reason: string }).reason.replace('blocked address (', '').replace(')', '')})` };
    }
  }
  for (const prefix of BLOCKED_V6_PREFIXES) {
    if (matchesPrefix(groups, prefix.groups, prefix.bits)) {
      return { reason: `blocked address (${prefix.label})` };
    }
  }
  return 'public';
}

/** Classifies an IP literal (v4 or v6) string. Pure; exported for tests. */
export function classifyIpLiteral(address: string): 'public' | { reason: string } {
  const trimmed = address.trim();
  if (trimmed.includes(':')) return classifyIpv6(trimmed);
  return classifyIpv4(trimmed);
}

/** One validated public address handed to the socket layer. */
export interface PublicAddress {
  address: string;
  family: number;
}

/** Result of resolving a hostname to ONLY public addresses. */
export type PublicLookup =
  | { ok: true; addresses: PublicAddress[] }
  | { ok: false; reason: string };

/** True when the hostname is a blocked literal IP or the loopback name. */
function blockedHostname(hostname: string): { reason: string } | null {
  const host = hostname.trim().toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    return { reason: 'blocked hostname (localhost)' };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    const v = classifyIpv4(bare);
    return v === 'public' ? null : v;
  }
  if (bare.includes(':')) {
    const v = classifyIpv6(bare);
    return v === 'public' ? null : v;
  }
  return null;
}

/**
 * Resolves `hostname` to ONLY public addresses (every A/AAAA answer must be
 * public — one private answer refuses the whole hostname, closing DNS
 * rebinding). Literal IP hosts are classified without DNS. Never throws:
 * returns `{ ok: false, reason }` on failure.
 */
export async function lookupPublic(hostname: string): Promise<PublicLookup> {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (bare === '') return { ok: false, reason: 'URL has no host' };
  const literalBlock = blockedHostname(bare);
  if (literalBlock !== null) return { ok: false, reason: literalBlock.reason };
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    return { ok: true, addresses: [{ address: bare, family: 4 }] };
  }
  if (bare.includes(':') && !bare.includes('.')) {
    return { ok: true, addresses: [{ address: bare, family: 6 }] };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAll(bare, { all: true, verbatim: true }) as unknown as Array<{ address: string; family: number }>;
  } catch {
    return { ok: false, reason: 'hostname did not resolve' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'hostname did not resolve' };
  const publicAddresses: PublicAddress[] = [];
  for (const entry of addresses) {
    const verdict = classifyIpLiteral(entry.address);
    if (verdict !== 'public') {
      return { ok: false, reason: `resolves to ${(verdict as { reason: string }).reason}` };
    }
    publicAddresses.push({ address: entry.address, family: entry.family === 6 ? 6 : 4 });
  }
  return { ok: true, addresses: publicAddresses };
}

/** Result of the pre-fetch URL safety check. */
export type UrlSafety =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verifies a URL is safe for a server-side fetch: https only, and every DNS
 * answer (or the literal host) must be public. Returns `{ ok: true }` or a
 * human-readable refusal reason. DNS failures refuse closed.
 */
export async function assertSafeFetchUrl(rawUrl: string): Promise<UrlSafety> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'only https URLs are fetched during export' };
  }
  const resolved = await lookupPublic(parsed.hostname);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Pinned https fetch with validated redirects                         */
/* ------------------------------------------------------------------ */


/** Result of resolving a redirect Location against the current URL. */
export type RedirectTarget =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Resolves and validates a redirect Location BEFORE it is followed. Pure
 * (no network): the target must parse, be https, and its hostname must not
 * be a blocked literal (loopback/private/link-local/metadata/etc.). DNS
 * validation of the target hostname happens in the follow hop itself via
 * lookupPublic, so a hostname that resolves privately is refused there.
 */
export async function validateRedirectTarget(currentUrl: string, location: string): Promise<RedirectTarget> {
  let next: URL;
  try {
    next = new URL(location, currentUrl);
  } catch {
    return { ok: false, reason: "redirect Location is not a valid URL" };
  }
  if (next.protocol !== "https:") {
    return { ok: false, reason: "redirect refused: only https targets are followed" };
  }
  const safety = await assertSafeFetchUrl(next.toString());
  if (!safety.ok) {
    return { ok: false, reason: `redirect refused: ${safety.reason}` };
  }
  return { ok: true, url: next.toString() };
}

/** Outcome of a bounded safe fetch. */
export type SafeFetchResult =
  | { ok: true; status: number; bytes: Uint8Array }
  | { ok: false; reason: string };

export interface SafeFetchOptions {
  /** Maximum response body bytes (default 8 MiB). */
  maxBytes?: number;
  /** Per-hop timeout ms (default 8000). */
  timeoutMs?: number;
  /** Maximum redirect hops (default 3). */
  maxRedirects?: number;
}

/**
 * Fetches an https URL with the SSRF pinning + redirect policy:
 *  - Only https. The socket connects through a custom `lookup` that hands
 *    Node ONLY the addresses validated as public at resolve time — the
 *    connection cannot re-resolve to a private IP (no check/connect race).
 *  - Redirects (301/302/303/307/308) are followed MANUALLY, at most
 *    `maxRedirects` hops, and each Location is re-validated (https + public
 *    pinning) before the next hop. A redirect to plaintext http or to a
 *    private/link-local/metadata/loopback target is refused.
 *  - Body reads are bounded by `maxBytes`; the request is aborted after
 *    `timeoutMs` per hop.
 * Never throws for network/redirect/policy failures — returns
 * `{ ok: false, reason }`.
 */
export function safeMediaFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxRedirects = options.maxRedirects ?? 3;
  return fetchHop(rawUrl, maxBytes, timeoutMs, maxRedirects, 0);
}

function fetchHop(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
  maxRedirects: number,
  hop: number,
): Promise<SafeFetchResult> {
  return new Promise<SafeFetchResult>((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      resolve({ ok: false, reason: 'not a valid URL' });
      return;
    }
    if (parsed.protocol !== 'https:') {
      resolve({ ok: false, reason: 'only https URLs are fetched during export' });
      return;
    }
    const hostname = parsed.hostname;
    void lookupPublic(hostname).then((resolved) => {
      if (!resolved.ok) {
        resolve({ ok: false, reason: resolved.reason });
        return;
      }
      // The connect lookup returns ONLY the validated public addresses to
      // Node's socket layer (array form, which Node 22's net.connect expects
      // when options.all is set). No re-resolution happens after this.
      const pinnedLookup = (
        _host: string,
        _opts: { all?: boolean },
        cb: (err: Error | null, addresses?: Array<{ address: string; family: number }>) => void,
      ): void => {
        cb(null, resolved.addresses);
      };

      const req = httpsRequest({
        hostname,
        port: parsed.port === '' ? 443 : Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'cuelingua-export/1.0',
          Accept: 'image/*,*/*;q=0.8',
        },
        lookup: pinnedLookup as never,
        timeout: timeoutMs,
      }, (res) => {
        const status = res.statusCode ?? 0;
        // Redirect: validate Location manually, then follow (bounded).
        if (status >= 300 && status < 400 && res.headers.location !== undefined) {
          res.resume(); // drain
          if (hop >= maxRedirects) {
            resolve({ ok: false, reason: `too many redirects (${maxRedirects})` });
            return;
          }
          // Resolve + validate the redirect target BEFORE following (https,
          // no blocked literal host; the follow hop re-pins its DNS).
          void validateRedirectTarget(rawUrl, res.headers.location).then((target) => {
            if (!target.ok) {
              resolve({ ok: false, reason: target.reason });
              return;
            }
            resolve(fetchHop(target.url, maxBytes, timeoutMs, maxRedirects, hop + 1));
          });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ ok: false, reason: `fetch failed (HTTP ${status})` });
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            aborted = true;
            req.destroy(new Error(`response too large (> ${maxBytes} bytes)`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          resolve({ ok: true, status, bytes: new Uint8Array(Buffer.concat(chunks)) });
        });
        res.on('error', () => {
          if (!aborted) resolve({ ok: false, reason: 'unreachable or timed out' });
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', () => {
        resolve({ ok: false, reason: 'unreachable or timed out' });
      });
      req.end();
    });
  });
}
