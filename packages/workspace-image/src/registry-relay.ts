// Self-contained: this file is also copied into workspaces and run with Bun.
// No package dependencies may be added to the workspace-side runner.
const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** The caller and its Docker daemon share a network namespace. Inherited
 * clients bridge their own loopback, not the installation owner's loopback. */
export function createRegistryRelay(socket: string): Bun.Server<undefined> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of hopHeaders) headers.delete(name);
    headers.set("host", "localhost");
    headers.set("accept-encoding", "identity");
    const upstream = await fetch(`http://localhost${url.pathname}${url.search}`, {
      unix: socket, method: request.method, headers, redirect: "manual",
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of hopHeaders) responseHeaders.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } });
}

if (import.meta.main) {
  const [socket, image, ...aliases] = process.argv.slice(2);
  if (!socket?.startsWith("/") || !image || !/^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(image) || aliases.some(alias => !alias || alias.startsWith("-") || alias.includes("@"))) {
    throw new Error("usage: registry-relay.ts <absolute socket> <repository@sha256:digest> [tag aliases...]");
  }
  const relay = createRegistryRelay(socket);
  const reference = `127.0.0.1:${relay.port}/${image}`;
  const docker = async (args: string[]) => {
    const process = Bun.spawn(["docker", ...args], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await process.exited;
    if (code !== 0) throw new Error(`Docker preload ${args[0]} failed with exit code ${code}`);
  };
  try {
    await docker(["pull", reference]);
    // Even ID-only preloads need a durable local reference after the relay exits.
    const tags = aliases.length ? aliases : [`atelier-preloaded:${image.split("sha256:")[1]}`];
    for (const alias of tags) await docker(["tag", reference, alias]);
    await docker(["image", "rm", reference]);
  } finally { await relay.stop(true); }
}
