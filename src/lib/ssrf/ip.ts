/**
 * Proteção SSRF (servidor): decide se um IP é público e pode ser destino
 * da busca de playlist. Implementa a abordagem "block-list" do OWASP SSRF
 * Prevention Cheat Sheet (caso 2 — destinos arbitrários): por padrão são
 * bloqueados loopback, RFC1918, link-local, metadados de nuvem, multicast,
 * CGNAT, documentação, Teredo/6to4/NAT64 e IPv4 embutido em IPv6.
 */

import { isIP, isIPv4, isIPv6 } from "node:net";

type RangeV4 = [base: number, mask: number];

function ipv4ToLong(ip: string): number | null {
  if (!isIPv4(ip)) return null; // rejeita hex/octal/dword (parser estrito da plataforma)
  const parts = ip.split(".").map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

const BLOCKED_V4: RangeV4[] = [
  [0x00000000, 0xff000000], // 0.0.0.0/8 "this host"
  [0x0a000000, 0xff000000], // 10/8 RFC1918
  [0x64400000, 0xffc00000], // 100.64/10 CGNAT
  [0x7f000000, 0xff000000], // 127/8 loopback
  [0xa9fe0000, 0xffff0000], // 169.254/16 link-local (inclui 169.254.169.254 IMDS)
  [0xac100000, 0xfff00000], // 172.16/12 RFC1918
  [0xc0000000, 0xffffff00], // 192.0.0/24 IETF
  [0xc0000200, 0xffffff00], // 192.0.2/24 TEST-NET-1
  [0xc0586300, 0xffffff00], // 192.88.99/24
  [0xc0a80000, 0xffff0000], // 192.168/16 RFC1918
  [0xc6120000, 0xfffe0000], // 198.18/15 benchmark
  [0xc6336400, 0xffffff00], // 198.51.100/24 TEST-NET-2
  [0xcb007100, 0xffffff00], // 203.0.113/24 TEST-NET-3
  [0xe0000000, 0xf0000000], // 224/4 multicast
  [0xf0000000, 0xf0000000], // 240/4 reservado (inclui broadcast)
];

/** Expande IPv6 (incl. "::" e IPv4 embutido) para 16 bytes. null = inválido. */
export function ipv6ToBytes(input: string): Uint8Array | null {
  let addr = input.toLowerCase();
  const zoneIdx = addr.indexOf("%");
  if (zoneIdx !== -1) addr = addr.slice(0, zoneIdx);
  if (!isIPv6(addr)) return null;

  // IPv4 embutido no final (::ffff:1.2.3.4 / ::1.2.3.4 / forma cheia):
  // substitui o trecho IPv4 por dois hextets equivalentes e parseia normal.
  if (addr.includes(".")) {
    const lastColon = addr.lastIndexOf(":");
    if (lastColon === -1) return null;
    const long = ipv4ToLong(addr.slice(lastColon + 1));
    if (long === null) return null;
    const hi = ((long >>> 16) & 0xffff).toString(16);
    const lo = (long & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
    if (!isIPv6(addr)) return null;
  }

  const sides = addr.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const right = sides.length === 2 ? (sides[1] ? sides[1].split(":").filter(Boolean) : []) : [];
  for (const h of [...left, ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
  }
  const missing = 8 - left.length - right.length;
  if (sides.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;
  const hextets = [
    ...left.map((h) => parseInt(h, 16)),
    ...Array<number>(missing).fill(0),
    ...right.map((h) => parseInt(h, 16)),
  ];
  const bytes = new Uint8Array(16);
  hextets.forEach((h, i) => {
    bytes[i * 2] = (h >> 8) & 0xff;
    bytes[i * 2 + 1] = h & 0xff;
  });
  return bytes;
}

function isBlockedV6(bytes: Uint8Array): boolean {
  const b = bytes;
  const allZero = b.every((v) => v === 0);
  if (allZero) return true; // ::/128 não especificado
  // ::1 loopback
  if (b.slice(0, 15).every((v) => v === 0) && b[15] === 1) return true;
  // ::ffff:a.b.c.d (IPv4-mapeado) e ::a.b.c.d (compatível): checa o IPv4 interno
  const mappedPrefix = b.slice(0, 10).every((v) => v === 0) && b[10] === 0xff && b[11] === 0xff;
  const compatPrefix = b.slice(0, 12).every((v) => v === 0);
  if (mappedPrefix || compatPrefix) {
    const v4 = [b[12], b[13], b[14], b[15]].join(".");
    const long = ipv4ToLong(v4);
    if (long !== null && BLOCKED_V4.some(([base, mask]) => ((long & mask) >>> 0) === base)) return true;
    if (long !== null) return false; // mapeado para IP público é permitido
  }
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 doc
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // 64:ff9b::/96 NAT64
  return false;
}

/** true = destino público permitido; false = bloqueado por política. */
export function isPublicIp(ip: string): boolean {
  const cleaned = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const kind = isIP(cleaned);
  if (kind === 4) {
    const long = ipv4ToLong(cleaned);
    if (long === null) return false;
    return !BLOCKED_V4.some(([base, mask]) => ((long & mask) >>> 0) === base);
  }
  if (kind === 6) {
    const bytes = ipv6ToBytes(cleaned);
    if (!bytes) return false;
    return !isBlockedV6(bytes);
  }
  return false;
}
