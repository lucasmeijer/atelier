/** One table covers current and future workspace bridges, independent of Docker's rules. */
const rules = `add table inet atelier_workspaces
flush table inet atelier_workspaces
table inet atelier_workspaces {
  set non_public_v4 {
    type ipv4_addr; flags interval;
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8,
      169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24,
      192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24,
      224.0.0.0/4, 240.0.0.0/4 }
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "atw-*" ct state established,related counter accept
    iifname "atw-*" ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } counter accept
    iifname "atw-*" counter drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "atw-*" oifname "atw-*" counter drop
    iifname "atw-*" ip daddr @non_public_v4 counter drop
    iifname "atw-*" ip6 daddr != 2000::/3 counter drop
    iifname "atw-*" ip6 daddr 2001:db8::/32 counter drop
  }
}
`;
export async function installWorkspaceFirewall() {
  // Atomic batch replacement touches only our table; Docker NAT/filter rules survive.
  const process = Bun.spawn(["nft", "-f", "-"], {
    stdin: new TextEncoder().encode(rules),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (code !== 0)
    throw new Error(`Could not install workspace firewall: ${error || output}`);
}
