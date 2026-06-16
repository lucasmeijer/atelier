// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

import net from "node:net";

export function parseIPv4Bytes(ip: string): Buffer | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => Number(p));
  if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  return Buffer.from(bytes);
}

function parseIPv4ToHextets(ip: string): [number, number] | null {
  const buf = parseIPv4Bytes(ip);
  if (!buf) return null;
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

export function parseIPv6Hextets(ip: string): number[] | null {
  if (net.isIP(ip) !== 6) return null;
  const normalized = ip.toLowerCase();
  const splitIndex = normalized.indexOf("::");

  if (splitIndex !== -1) {
    const left = normalized.slice(0, splitIndex) ? normalized.slice(0, splitIndex).split(":") : [];
    const right = normalized.slice(splitIndex + 2) ? normalized.slice(splitIndex + 2).split(":") : [];
    const leftExpanded = expandIpv6Parts(left);
    const rightExpanded = expandIpv6Parts(right);
    if (!leftExpanded || !rightExpanded) return null;
    const missing = 8 - (leftExpanded.length + rightExpanded.length);
    if (missing < 0) return null;
    return [...leftExpanded, ...Array(missing).fill(0), ...rightExpanded];
  }

  const expanded = expandIpv6Parts(normalized.split(":"));
  return expanded && expanded.length === 8 ? expanded : null;
}

function expandIpv6Parts(parts: string[]): number[] | null {
  const expanded: number[] = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const v4 = parseIPv4ToHextets(part);
      if (!v4) return null;
      expanded.push(...v4);
      continue;
    }
    if (part.length === 0) continue;
    const value = parseInt(part, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    expanded.push(value);
  }
  return expanded;
}

export function extractIPv4Mapped(hextets: number[]): string | null {
  if (hextets.length !== 8) return null;
  if (!hextets.slice(0, 5).every((value) => value === 0) || hextets[5] !== 0xffff) return null;
  return `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
}

export function isInternalAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return false;
}

export function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && (b >= 64 && b <= 127 || b === 100)) return true; // CGNAT plus 100.100.100.200 metadata.
  if (a >= 224) return true; // multicast/reserved/broadcast
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const hextets = parseIPv6Hextets(ip);
  if (!hextets) return false;
  const isAllZero = hextets.every((value) => value === 0);
  const isLoopback = hextets.slice(0, 7).every((value) => value === 0) && hextets[7] === 1;
  if (isAllZero || isLoopback) return true;
  if ((hextets[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((hextets[0]! & 0xffc0) === 0xfe80) return true; // link-local
  if ((hextets[0]! & 0xff00) === 0xff00) return true; // multicast
  const mapped = extractIPv4Mapped(hextets);
  return Boolean(mapped && isPrivateIPv4(mapped));
}
