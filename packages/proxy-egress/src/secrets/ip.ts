// Portions adapted from @earendil-works/gondolin, Apache-2.0.
// Source: https://github.com/earendil-works/gondolin

import net from "node:net";

const internalAddresses = new net.BlockList();

internalAddresses.addSubnet("0.0.0.0", 8, "ipv4");
internalAddresses.addSubnet("10.0.0.0", 8, "ipv4");
internalAddresses.addSubnet("100.64.0.0", 10, "ipv4");
internalAddresses.addAddress("100.100.100.200", "ipv4");
internalAddresses.addSubnet("127.0.0.0", 8, "ipv4");
internalAddresses.addSubnet("169.254.0.0", 16, "ipv4");
internalAddresses.addSubnet("172.16.0.0", 12, "ipv4");
internalAddresses.addSubnet("192.168.0.0", 16, "ipv4");
internalAddresses.addSubnet("224.0.0.0", 4, "ipv4");

internalAddresses.addAddress("::", "ipv6");
internalAddresses.addAddress("::1", "ipv6");
internalAddresses.addSubnet("fc00::", 7, "ipv6");
internalAddresses.addSubnet("fe80::", 10, "ipv6");
internalAddresses.addSubnet("ff00::", 8, "ipv6");

export function isInternalAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return internalAddresses.check(ip, "ipv4");
  if (family === 6) return internalAddresses.check(ip, "ipv6");
  return false;
}
