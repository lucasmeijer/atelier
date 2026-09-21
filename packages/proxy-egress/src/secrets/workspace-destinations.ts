import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";

const specialAddresses = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  specialAddresses.addSubnet(address, prefix, "ipv4");
}
specialAddresses.addAddress("::", "ipv6");
specialAddresses.addAddress("::1", "ipv6");
specialAddresses.addSubnet("fe80::", 10, "ipv6");
specialAddresses.addSubnet("ff00::", 8, "ipv6");

/** The proxy runs on System's network, so it must not bypass workspace isolation.
 * Read interfaces for each decision: workspace bridges appear and disappear at runtime.
 */
export function isWorkspaceDestinationAllowed(ip: string, interfaces = networkInterfaces()): boolean {
  const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
  if (specialAddresses.check(ip, family)) return false;
  const protectedAddresses = new BlockList();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      const addressFamily = address.family === "IPv6" ? "ipv6" : "ipv4";
      protectedAddresses.addAddress(address.address, addressFamily);
      if (name.startsWith("atw-") && address.cidr) {
        const [network, prefix] = address.cidr.split("/");
        protectedAddresses.addSubnet(network!, Number(prefix), addressFamily);
      }
    }
  }
  return !protectedAddresses.check(ip, family);
}
