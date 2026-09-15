import net from "node:net";
import { pathToFileURL } from "node:url";

// Every client connection opens the current socket inode. Recreating the app's
// socket after an update therefore needs no workspace restart or reconfiguration.
export function createLocalProxy(socketPath) {
  const connections = new Set();
  const server = net.createServer(client => {
    const upstream = net.createConnection(socketPath);
    connections.add(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("close", () => { connections.delete(client); upstream.destroy(); });
    upstream.once("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  return {
    server,
    async close() {
      for (const client of connections) client.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = createLocalProxy("/run/atelier-parent/egress.sock");
  proxy.server.listen(58124, "127.0.0.1");
}
