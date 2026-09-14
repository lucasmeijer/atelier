/** Run inside a disposable Atelier System with the real app already healthy:
 * bun system-lifecycle.integration.ts [--app-url http://127.0.0.1:3000] [--supervisor-url http://127.0.0.1:3001]
 * Exercises APIs and container behavior, not UI. On failure it retains fixtures for diagnosis.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  "app-url": { type: "string", default: "http://127.0.0.1:3000" },
  "supervisor-url": { type: "string", default: "http://127.0.0.1:3001" },
} });
const appUrl = values["app-url"]!;
const supervisorUrl = values["supervisor-url"]!;
const marker = `atelier-lifecycle-${randomUUID()}`;
const repository = `/data/app/${marker}`;
const fixtures: string[] = [];
let projectId: string | undefined;
interface Workspace { id: string; phase: string; parked?: boolean; error?: string; issues?: unknown[]; }
interface Container {
  Id: string; Name: string; Image: string; State: { Running: boolean };
  HostConfig: { NetworkMode: string; PortBindings: Record<string, unknown> | null };
  NetworkSettings: { Networks: Record<string, { NetworkID: string; IPAddress: string; Gateway: string }> };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
}
interface ResourceIdentity { containerId: string; networkId: string; networkName: string; volumeName: string; }
async function run(args: string[], check = true) {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (check && code !== 0) throw new Error(`${args.slice(0, 5).join(" ")} failed (${code}): ${stderr || stdout}`);
  return { stdout, stderr, code };
}
const docker = async (...args: string[]) => (await run(["docker", ...args])).stdout.trim();
const exec = (container: string, ...args: string[]) => docker("exec", "--user", "root", container, ...args);
async function api<T>(path: string, body?: unknown, base = appUrl): Promise<T> {
  const response = await fetch(new URL(path, base), { method: body === undefined ? "GET" : "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${text}`);
  return JSON.parse(text) as T;
}
async function waitFor(description: string, check: () => Promise<boolean>, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(250); }
  throw new Error(`Timed out: ${description}`);
}
async function ready(id: string) {
  await waitFor(`workspace ${id} ready`, async () => {
    const { workspace } = await api<{ workspace: Workspace }>(`/workspaces/${id}`);
    if (workspace.phase === "failed" || workspace.issues?.length) throw new Error(`Workspace ${id}: ${JSON.stringify(workspace)}`);
    return workspace.phase === "ready" && !workspace.parked;
  }, 900_000);
}
async function create(source: { type: "empty" } | { type: "project"; project: string }) {
  const { workspace } = await api<{ workspace: Workspace }>("/workspaces", { source, title: marker });
  fixtures.push(workspace.id);
  await ready(workspace.id);
  return workspace.id;
}
async function containerFor(id: string): Promise<Container> {
  const name = await docker("ps", "-aq", "--filter", `label=com.atelier.workspace-id=${id}`);
  assert(name && !name.includes("\n"), `exactly one container for ${id}`);
  return JSON.parse(await docker("inspect", name))[0];
}
function topology(container: Container): ResourceIdentity {
  const networks = Object.entries(container.NetworkSettings.Networks);
  assert.equal(networks.length, 1, "workspace has exactly one network");
  const [networkName, network] = networks[0]!;
  assert(!["bridge", "host", "none"].includes(networkName), "workspace owns a dedicated network");
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0, "workspace publishes no gateway ports");
  const volume = container.Mounts.find((mount) => mount.Destination === "/data");
  assert(volume?.Type === "volume" && volume.RW && volume.Name, "workspace has a private writable /data volume");
  const cache = container.Mounts.find((mount) => mount.Destination === "/data/erofs-cache");
  assert(cache?.Type === "bind" && cache.Source === "/data/erofs-cache" && !cache.RW, "shared EROFS cache is a readonly bind mount");
  const sockets = container.Mounts.find((mount) => mount.Destination === "/run/atelier-parent");
  assert(sockets?.Type === "bind" && !sockets.RW && sockets.Source.startsWith("/data/app/workspace-sockets/"), "mount the scoped parent socket directory readonly");
  return { containerId: container.Id, networkId: network.NetworkID, networkName, volumeName: volume.Name };
}
async function daemon(container: string, name: string) { return exec(container, "systemctl", "show", "--property=ActiveState", "--value", `${name}.service`); }
async function publish(container: string) {
  return JSON.parse(await exec(container, "curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--unix-socket", "/run/atelier-parent/ingress.sock", "-H", "Content-Type: application/json", "--data", '{"port":8080}', "http://localhost/origins")) as { origin: string };
}
async function startPreview(container: string) {
  await docker("exec", "--user", "root", "-d", container, "bun", "-e", `Bun.serve({hostname:'127.0.0.1',port:8080,fetch(r){return new Response(${JSON.stringify(marker)}+new URL(r.url).pathname+new URL(r.url).search)}})`);
  await waitFor("workspace dev server", async () => (await run(["docker", "exec", container, "curl", "--noproxy", "*", "--fail", "--silent", "http://127.0.0.1:8080/products"], false)).stdout === `${marker}/products`);
}
async function preview(origin: string) {
  const text = (await run(["docker", "exec", "atelier", "curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--max-time", "15", `${origin}/products?sort=true`])).stdout;
  assert.equal(text, `${marker}/products?sort=true`, "published origin preserves path and query");
}
async function parkResume(id: string, identity: ResourceIdentity) {
  await api(`/workspaces/${id}/park?force=1`, {});
  await waitFor("container parked", async () => !(await containerFor(id)).State.Running);
  await api(`/workspaces/${id}/unpark`, {});
  await ready(id);
  assert.deepEqual(topology(await containerFor(id)), identity, "park/unpark preserves container, network and private volume");
}
async function absent(kind: "container" | "network" | "volume", id: string) {
  assert.notEqual((await run(["docker", kind, "inspect", id], false)).code, 0, `${kind} removed`);
}
async function removeWorkspace(id: string, identity: ResourceIdentity) {
  await api(`/workspaces/${id}/delete`, { force: true });
  await waitFor("workspace deleted", async () => !(await api<{ workspaces: Workspace[] }>("/workspaces")).workspaces.some((workspace) => workspace.id === id));
  await absent("container", identity.containerId);
  await absent("network", identity.networkId);
  await absent("volume", identity.volumeName);
  await assert.rejects(stat(`/data/app/workspace-sockets/${id}`), { code: "ENOENT" });
  await assert.rejects(stat(`/data/app/workspaces/${id}`), { code: "ENOENT" });
  await assert.rejects(stat(`/data/app/workspaces/${id}`), { code: "ENOENT" });
  fixtures.splice(fixtures.indexOf(id), 1);
}
async function terminalChecks(workspaceId: string, container: string) {
  const externalSession = `external-${randomUUID()}`;
  type View = { reference: { type: string; terminalId?: string } };
  type Terminal = { id: string; tmuxSession: string; sessionRelationship: string };
  const views = async () => (await api<{ workspace: { workViews: View[] } }>(`/workspaces/${workspaceId}`)).workspace.workViews;
  const metadata = async (): Promise<Terminal[]> => JSON.parse(await readFile(`/data/app/workspaces/${workspaceId}/metadata/terminals.json`, "utf8"));
  const initialViews = await views();
  await docker("exec", "--user", "atelier", container, "tmux", "new-session", "-d", "-s", externalSession);
  assert.deepEqual(await views(), initialViews, "unattached tmux sessions do not become terminal views");
  const attachedResponse = await fetch(new URL(`/workspaces/${workspaceId}/terminals/attach`, appUrl), {
    method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams({ session: externalSession }),
  });
  assert(attachedResponse.ok, `attach terminal: ${attachedResponse.status}`);
  await attachedResponse.text();
  const attached = (await metadata()).find((terminal) => terminal.tmuxSession === externalSession);
  assert(attached && attached.sessionRelationship === "attached");
  await api(`/workspaces/${workspaceId}/work-views/close`, { reference: { type: "terminal", terminalId: attached.id } });
  assert(!(await metadata()).some((terminal) => terminal.id === attached.id));
  await docker("exec", "--user", "atelier", container, "tmux", "has-session", "-t", externalSession);
  await docker("exec", "--user", "atelier", container, "tmux", "kill-session", "-t", externalSession);
  const title = `owned-${randomUUID()}`;
  const created = await api<{ command: { workView: { type: "terminal"; terminalId: string } } }>(`/workspaces/${workspaceId}/commands/terminal.create`, { title, cwd: "/work" });
  const owned = (await metadata()).find((terminal) => terminal.id === created.command.workView.terminalId);
  assert(owned && owned.sessionRelationship === "owned" && owned.tmuxSession === title);
  await docker("exec", "--user", "atelier", container, "tmux", "has-session", "-t", title);
  await api(`/workspaces/${workspaceId}/work-views/close`, { reference: created.command.workView });
  assert(!(await metadata()).some((terminal) => terminal.id === owned.id));
  assert.notEqual((await run(["docker", "exec", "--user", "atelier", container, "tmux", "has-session", "-t", title], false)).code, 0, "closing owned terminal kills its tmux session");
}
async function digest(path: string) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

try {
  const contract = await api<{ paths: Record<string, unknown> }>("/openapi.json");
  for (const path of ["/workspaces", "/projects/{projectId}/preload-images", "/workspaces/{id}/park"]) assert(path in contract.paths, `API advertises ${path}`);
  const appBefore: Container = JSON.parse(await docker("inspect", "atelier"))[0];
  console.log("Create projectless workspace; verify networking, mounts and lazy daemons");
  const emptyId = await create({ type: "empty" });
  const empty = await containerFor(emptyId);
  const emptyIdentity = topology(empty);
  const network = JSON.parse(await docker("network", "inspect", emptyIdentity.networkName))[0];
  assert.match(network.Options["com.docker.network.bridge.name"], /^atw-[a-f0-9]{11}$/, "workspace bridge is identifiable by the System firewall");
  assert.equal(await daemon(empty.Id, "containerd"), "inactive");
  assert.equal(await daemon(empty.Id, "docker"), "inactive");
  await exec(empty.Id, "sh", "-c", `printf '%s' '${marker}' > /work/lifecycle-marker; printf '%s' '${marker}' > /data/lifecycle-marker`);
  await startPreview(empty.Id);
  const origin = (await publish(empty.Id)).origin;
  assert.equal(new URL(origin).protocol, "https:", "System publishes browser-trusted HTTPS through Tailscale");
  await preview(origin);
  await parkResume(emptyId, emptyIdentity);
  assert.equal(await exec(empty.Id, "cat", "/work/lifecycle-marker"), marker);
  assert.equal(await exec(empty.Id, "cat", "/data/lifecycle-marker"), marker);
  await startPreview(empty.Id);
  assert.equal((await publish(empty.Id)).origin, origin, "preview origin survives parking");
  await preview(origin);

  console.log("Replace only the app through supervisor; verify workspace and ingress recovery");
  await api("/update", { image: appBefore.Image }, supervisorUrl);
  await waitFor("supervisor app replacement", async () => {
    const status = await api<{ busy: boolean; healthy: boolean; failure?: string }>("/status", undefined, supervisorUrl);
    if (status.failure) throw new Error(status.failure);
    if (status.busy || !status.healthy) return false;
    const current: Container = JSON.parse(await docker("inspect", "atelier"))[0];
    return current.Id !== appBefore.Id;
  }, 180_000);
  await ready(emptyId);
  assert.deepEqual(topology(await containerFor(emptyId)), emptyIdentity);
  assert.equal((await publish(empty.Id)).origin, origin, "preview origin survives app replacement");
  await preview(origin);

  console.log("Verify terminal session ownership through the real app API");
  await terminalChecks(emptyId, empty.Id);

  console.log("Create a project with Alpine preload and a test-only egress secret");
  await docker("exec", "--user", "1000", "atelier", "sh", "-eu", "-c", `mkdir '${repository}'; cd '${repository}'; git init -b main; git config user.name Acceptance; git config user.email acceptance@example.invalid; printf fixture > README; git add README; git commit -m fixture`);
  projectId = (await api<{ project: { id: string } }>("/projects", { gitUrl: repository })).project.id;
  await api(`/projects/${projectId}/preload-images`, { preloadImages: ["alpine:3.21"] });
  const secret = `test-only-${randomUUID()}`;
  await api(`/projects/${projectId}/secrets`, { envName: "LIFECYCLE_TEST_SECRET", hostPattern: "httpbin.org", secretValue: secret });
  const loadedId = await create({ type: "project", project: projectId });
  const loaded = await containerFor(loadedId);
  const loadedIdentity = topology(loaded);
  assert.notEqual(loadedIdentity.networkId, emptyIdentity.networkId);
  assert.notEqual(loadedIdentity.volumeName, emptyIdentity.volumeName);
  assert.equal(await daemon(loaded.Id, "containerd"), "active");
  assert.equal(await daemon(loaded.Id, "docker"), "inactive", "preloading leaves dockerd asleep");
  const preloadPath = `/data/app/workspaces/${loadedId}/preloads.json`;
  const pinned = await readFile(preloadPath, "utf8");
  const images: { requested: string; reference: string }[] = JSON.parse(pinned);
  assert.equal(images.length, 1);
  assert.match(images[0]!.reference, /^docker\.io\/library\/alpine:3\.21@sha256:[a-f0-9]{64}$/);
  const links = (await exec(loaded.Id, "sh", "-c", "find /data/containerd/io.containerd.snapshotter.v1.erofs/snapshots -name layer.erofs -type l -exec readlink {} +")).split("\n").filter(Boolean);
  assert(links.length > 0, "import installed EROFS snapshot links");
  assert(links.every((path) => path.startsWith("/data/erofs-cache/")), "private snapshots use the shared cache");
  const hashes = new Map(await Promise.all([...new Set(links)].map(async (path) => [path, await digest(path)] as const)));
  const content = () => exec(loaded.Id, "ctr", "--namespace", "moby", "content", "ls", "--quiet");
  const beforeContent = (await content()).split("\n").filter(Boolean).sort();
  const listing = await exec(loaded.Id, "ctr", "--namespace", "moby", "images", "ls");
  const row = listing.split("\n").find((line) => line.startsWith("docker.io/library/alpine:3.21 "));
  assert(row, "import registered the requested image tag");
  const manifestDigest = row.split(/\s+/)[2]!;
  const manifest: { layers: { digest: string }[] } = JSON.parse(await exec(loaded.Id, "ctr", "--namespace", "moby", "content", "get", manifestDigest));
  assert(manifest.layers.length > 0);
  for (const layer of manifest.layers) assert(!beforeContent.includes(layer.digest), "base layer blob was not downloaded");
  assert.equal(await exec(loaded.Id, "docker", "run", "--rm", "--pull=never", "--network=none", "alpine:3.21", "echo", marker), marker);
  assert.equal(await daemon(loaded.Id, "docker"), "active", "Docker starts on first socket use");
  const afterContent = (await content()).split("\n").filter(Boolean);
  for (const layer of manifest.layers) assert(!afterContent.includes(layer.digest), "running adds no base-layer blobs");
  await exec(loaded.Id, "sh", "-ec", "mkdir -p /data/lifecycle-build; printf 'FROM alpine:3.21\\nRUN echo built-offline > /built-marker\\n' > /data/lifecycle-build/Dockerfile");
  await exec(loaded.Id, "docker", "build", "--network=none", "--output", "type=image,store-allow-incomplete=true", "-t", "atelier-lifecycle-built:local", "/data/lifecycle-build");
  assert.equal(await exec(loaded.Id, "docker", "run", "--rm", "--pull=never", "--network=none", "atelier-lifecycle-built:local", "cat", "/built-marker"), "built-offline");
  const afterBuild = (await content()).split("\n").filter(Boolean);
  for (const layer of manifest.layers) assert(!afterBuild.includes(layer.digest), "building with incomplete export adds no base-layer blobs");
  for (const [path, hash] of hashes) assert.equal(await digest(path), hash, "shared EROFS files remain unchanged");
  const echoed = JSON.parse(await exec(loaded.Id, "sh", "-c", 'curl --fail --silent --show-error --max-time 30 -H "X-Atelier-Test: $LIFECYCLE_TEST_SECRET" https://httpbin.org/headers')) as { headers: Record<string, string> };
  const injected = Object.entries(echoed.headers).find(([name]) => name.toLowerCase() === "x-atelier-test")?.[1];
  assert.equal(injected, secret, "egress socket injects the project secret");
  await api(`/projects/${projectId}/preload-images`, { preloadImages: [] });
  await parkResume(loadedId, loadedIdentity);
  assert.equal(await readFile(preloadPath, "utf8"), pinned, "settings changes do not change existing workspace pins");

  console.log("Delete fixtures; check private resources are removed and shared cache retained");
  await removeWorkspace(loadedId, loadedIdentity);
  await removeWorkspace(emptyId, emptyIdentity);
  for (const [path, hash] of hashes) assert.equal(await digest(path), hash, "workspace deletion preserves shared cache");
  await api(`/projects/${projectId}/delete`, {});
  await exec("atelier", "rm", "-rf", repository);
  console.log("PASS: System workspace lifecycle, lazy daemons, shared EROFS, stable ingress, app replacement and egress injection");
} catch (error) {
  console.error("FAILED; fixtures retained for diagnosis:", { workspaces: fixtures, projectId, repository });
  throw error;
}
