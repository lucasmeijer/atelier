import { expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { isWorkspaceDestinationAllowed } from "../../src/secrets/workspace-destinations.ts";

function address(ip: string, prefix: number): NetworkInterfaceInfo {
  return { address: ip, cidr: `${ip}/${prefix}`, family: ip.includes(":") ? "IPv6" : "IPv4", netmask: ip.includes(":") ? "ffff:ffff:ffff:ffff::" : "255.255.255.0", mac: "00:00:00:00:00:00", internal: false, scopeid: 0 };
}
const interfaces = {
  eth0: [address("192.168.1.10", 24)],
  tailscale0: [address("100.64.0.10", 32), address("fd7a:115c:a1e0::10", 128)],
  "atw-one": [address("172.28.1.1", 24), address("fd12:3456:1::1", 64)],
};

test("private destinations on host networks are allowed, not System's own addresses", () => {
  for (const ip of ["192.168.1.20", "10.200.0.2", "100.64.0.20", "fd7a:115c:a1e0::20", "93.184.215.14", "::ffff:100.64.0.20"]) {
    expect(isWorkspaceDestinationAllowed(ip, interfaces)).toBe(true);
  }
  for (const ip of ["192.168.1.10", "100.64.0.10", "fd7a:115c:a1e0::10", "::ffff:192.168.1.10"]) {
    expect(isWorkspaceDestinationAllowed(ip, interfaces)).toBe(false);
  }
});

test("all workspace bridge addresses are protected, including newly created bridges", () => {
  for (const ip of ["172.28.1.1", "172.28.1.20", "fd12:3456:1::20", "::ffff:172.28.1.20"]) {
    expect(isWorkspaceDestinationAllowed(ip, interfaces)).toBe(false);
  }
  expect(isWorkspaceDestinationAllowed("172.28.2.20", interfaces)).toBe(true);
  expect(isWorkspaceDestinationAllowed("172.28.2.20", { ...interfaces, "atw-two": [address("172.28.2.1", 24)] })).toBe(false);
});

test("loopback, link-local, unspecified and multicast stay prohibited", () => {
  for (const ip of ["127.0.0.1", "127.10.0.1", "0.0.0.0", "169.254.169.254", "224.0.0.1", "::", "::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1"]) {
    expect(isWorkspaceDestinationAllowed(ip, interfaces)).toBe(false);
  }
});
