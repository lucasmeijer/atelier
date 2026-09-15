import { startLocalIngress } from "./local-ingress.ts";
import { installationStatus, type Activity } from "./installation-status.ts";
import { PullProgress } from "./pull-progress.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { installWorkspaceFirewall } from "./firewall.ts";
import { initializeResources } from "./resources.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { command, docker, sleep, stopCommands } from "./process.ts";
import { setSupervisorRoutes } from "./tailscale.ts";
import { button, escape, page } from "./ui.ts";

const { values } = parseArgs({
  options: {
    "access-mode": { type: "string", default: "tailscale" },
    "app-image": {
      type: "string",
      default: "ghcr.io/lucasmeijer/atelier:stable",
    },
  },
  strict: true,
});
const resources = await initializeResources();
const timeout = 120_000;
const stateDir = "/data/supervisor";
await Promise.all(
  [
    stateDir,
    "/data/app",
    "/data/tailscale",
    "/data/erofs-cache",
    "/run/tailscale",
  ].map((path) => mkdir(path, { recursive: true })),
);
type State = { accessMode?: "localhost" | "tailscale"; localPort?: number; currentImage?: string; runningContainers?: string[] };
const persisted: State = (await Bun.file(`${stateDir}/state.json`).exists())
  ? JSON.parse(await readFile(`${stateDir}/state.json`, "utf8"))
  : {};
persisted.accessMode ??= Value.Parse(Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")]), values["access-mode"]);
let remoteRequested = persisted.accessMode === "tailscale";
async function persist() {
  await writeFile(`${stateDir}/state.next`, JSON.stringify(persisted));
  await rename(`${stateDir}/state.next`, `${stateDir}/state.json`);
}
let activity: Activity = { description: "Starting Atelier services" };
let failure: string | undefined;
let candidate = persisted.currentImage ?? values["app-image"]!;
let busy = false;
let activeOperation: Promise<void> = Promise.resolve();
let startup: Promise<void> = Promise.resolve();
let initialized = false;
let healthy = false;
let stopping = false;
let tailnetHost: string | undefined;
let connectionState = "Starting";
let authUrl: string | undefined;
let connectionAttempt: "idle" | "running" | "finished" = "idle";
let connectionFailure: string | undefined;
let networkError: string | undefined;
let lastNetworkSuccess = Date.now();
let connectionStateSince = Date.now();
let routeTarget = 3001;
let logProcess: ChildProcess | undefined;
const logs: string[] = [];
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
function connectionProblem() {
  if (persisted.accessMode === "localhost") return;
  if (connectionFailure) return connectionFailure;
  if (networkError && Date.now() - lastNetworkSuccess >= 60_000)
    return `Could not prepare the private connection: ${networkError}`;
  const awaitingUser = connectionState === "NeedsMachineAuth" ||
    (connectionState === "NeedsLogin" && !!authUrl);
  if (connectionState !== "Running" && !awaitingUser && Date.now() - connectionStateSince >= 120_000)
    return "The private connection did not finish starting within 2 minutes.";
}
function fragment() {
  return `<h1>Atelier System</h1><h2>${escape(activity.description)}</h2><p>${escape(candidate)}</p>${authUrl ? `<p><a href="${escape(authUrl)}">Sign in to Tailscale</a></p>` : ""}<p>Access: ${persisted.accessMode}. Tailscale: ${escape(connectionState)}</p><form method="post" action="/connect">${button("Enable remote access")}</form><form method="post" action="/local">${button("Use local access")}</form>${failure ? `<p role="alert">${escape(failure)}</p><form method="post" action="/retry">${button("Retry")}</form>` : ""}<pre>${escape(logs.join("\n"))}</pre>`;
}
function emit(event = "progress", data = fragment()) {
  for (const subscriber of subscribers)
    subscriber.enqueue(
      encoder.encode(
        `event: ${event}\ndata: ${data.replace(/\n/g, "\ndata: ")}\n\n`,
      ),
    );
}
setInterval(() => emit("ping", ""), 15000);
function log(text: string) {
  text = text.trimEnd();
  console.log(text);
  logs.push(...text.split("\n"));
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  emit();
}
function stage(text: string) {
  activity = { description: text };
  log(text);
}
const children: ChildProcess[] = [];
function daemon(args: string[]) {
  const child = spawn(args[0]!, args.slice(1), { stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    log(error.message);
    void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      log(`${args[0]} exited (${code ?? signal})`);
      void shutdown(1);
    }
  });
  return child;
}
async function waitFor(
  check: () => Promise<boolean>,
  milliseconds: number,
  description: string,
) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end && !stopping) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function appIsHealthy() {
  try {
    return (
      await fetch("http://127.0.0.1:3000/up", {
        signal: AbortSignal.timeout(1000),
      })
    ).ok;
  } catch {
    return false;
  }
}
async function existsContainer() {
  return (await docker("ps", "-aq", "--filter", "name=^atelier$")).length > 0;
}
async function pullImage(reference: string, description: string) {
  const progress = new PullProgress();
  stage(description);
  try {
    await command(["docker", "pull", reference], (chunk) => {
      activity = { description, percent: progress.push(chunk) };
      log(chunk);
    }, 1_800_000);
  } finally {
    activity = { description };
  }
}
async function prepareImage(reference: string, pull: boolean): Promise<string> {
  // Resolve the exact local image ID once. No subsequent tag lookup can change the update.
  if (pull && !(await docker("image", "ls", "-q", reference)))
    await pullImage(reference, "Downloading Atelier");
  const image = JSON.parse(await docker("image", "inspect", reference))[0];
  const preload: unknown = JSON.parse(
    image.Config.Labels?.["eagerly-preload"] ?? "[]",
  );
  if (
    !Value.Check(Type.Array(Type.String({ minLength: 1, pattern: "^(?!-)" })), preload)
  )
    throw new Error("eagerly-preload must be a JSON array of image references");
  for (const ref of preload) {
    if (pull) await pullImage(ref, `Downloading workspace image ${ref}`);
    else await docker("image", "inspect", ref);
  }
  return image.Id;
}
let routing: Promise<void> = Promise.resolve();
let appliedRoute = "";
function configureRoutes(target: number): Promise<void> {
  routeTarget = target;
  // Serialize Serve mutations, always using the most recent desired destination.
  const previous = routing;
  routing = (async () => {
    try {
      await previous;
    } catch {
      /* Previous caller reports failure; this is its retry. */
    }
    while (tailnetHost && !stopping) {
      const key = `${tailnetHost}:${routeTarget}`;
      if (appliedRoute === key) return;
      const target = routeTarget;
      await setSupervisorRoutes(tailnetHost, target);
      appliedRoute = key;
    }
  })();
  return routing;
}
async function replace(reference: string, pull: boolean) {
  if (busy || stopping)
    throw new Error(
      "An app operation is already running or System is stopping",
    );
  busy = true;
  failure = undefined;
  healthy = false;
  candidate = reference;
  try {
    await configureRoutes(3001);
    stage("Preparing Atelier");
    const exact = await prepareImage(reference, pull);
    candidate = exact;
    if (stopping) return;
    stage("Stopping Atelier");
    logProcess?.kill();
    logProcess = undefined;
    if (await existsContainer()) {
      await docker("stop", "--time", "30", "atelier");
      await docker("rm", "atelier");
    }
    if (stopping) return;
    stage("Starting Atelier");
    await docker(
      "run",
      "-d",
      "--init",
      "--name",
      "atelier",
      "--network",
      "host",
      "--cgroup-parent",
      resources.managementCgroupParent,
      "--cgroupns",
      "host",
      "--mount",
      `type=bind,src=${resources.commandsCgroup},dst=/run/atelier-system/workload-processes`,
      "--mount",
      "type=bind,src=/run/atelier-system/resources.json,dst=/run/atelier-system/resources.json,readonly",
      "--label",
      "atelier.role=app",
      "--mount",
      "type=bind,src=/data/app,dst=/data/app",
      "--mount",
      "type=bind,src=/data/erofs-cache,dst=/data/erofs-cache",
      "--mount",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      "--mount",
      "type=bind,src=/run/containerd/containerd.sock,dst=/run/containerd/containerd.sock",
      "--mount",
      "type=bind,src=/var/run/tailscale,dst=/var/run/tailscale",
      exact,
    );
    logProcess = spawn(
      "docker",
      ["logs", "--follow", "--since", "1m", "atelier"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    for (const output of [logProcess.stdout!, logProcess.stderr!])
      output.on("data", (data) => log(data.toString().trimEnd()));
    stage("Checking Atelier is healthy");
    await waitFor(appIsHealthy, timeout, "Atelier health");
    persisted.currentImage = exact;
    await persist();
    await configureRoutes(3000);
    healthy = true;
    stage("Atelier is ready");
    emit("ready", "ready");
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    stage("Atelier needs attention");
    log(failure);
  } finally {
    busy = false;
    emit();
  }
}
function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return (
    !origin ||
    (persisted.localPort && origin === `http://atelier.localhost:${persisted.localPort}`) ||
    origin === new URL(request.url).origin ||
    (tailnetHost &&
      (origin === `https://${tailnetHost}` ||
        origin === `https://${tailnetHost}:8443`))
  );
}
const localIngress = startLocalIngress(() => routeTarget);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3001,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/access") {
      if (request.method === "POST") {
        if (!allowedOrigin(request)) return new Response("Forbidden", { status: 403 });
        const body: unknown = await request.json().catch(() => null);
        if (!Value.Check(Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("localhost"), Type.Literal("tailscale")])), localPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })) }), body)) return new Response("Invalid access setting", { status: 400 });
        if (body.localPort) persisted.localPort = body.localPort;
        if (body.mode === "localhost") { persisted.accessMode = "localhost"; remoteRequested = false; }
        if (body.mode === "tailscale") {
          remoteRequested = true;
          if (connectionState === "Running") persisted.accessMode = "tailscale";
          else { connectionAttempt = "idle"; connectionFailure = undefined; connectionStateSince = Date.now(); }
        }
        await persist();
        emit("access", "changed");
      }
      return Response.json({ mode: persisted.accessMode, localPort: persisted.localPort, connectionState, authUrl, error: connectionFailure ?? networkError });
    }
    if (url.pathname === "/status") {
      // Check again at the handoff: startup health alone can become stale.
      const appResponding = await appIsHealthy() && healthy;
      return Response.json({
        ...installationStatus({
          activity: healthy && !appResponding ? { description: "Checking Atelier is healthy" } : activity,
          failure: failure ?? connectionProblem(),
          stopping, busy, appResponding, hostname: tailnetHost, appliedRoute,
          connectionState, authUrl, logs,
          localOrigin: persisted.localPort ? `http://atelier.localhost:${persisted.localPort}` : undefined,
          localMode: persisted.accessMode === "localhost" && !remoteRequested,
        }),
        failure,
        healthy,
        busy,
        candidate,
        currentImage: persisted.currentImage,
        tailnetHost,
        logs,
      });
    }
    if (url.pathname === "/events") {
      const origin = request.headers.get("origin");
      if (origin && !allowedOrigin(request))
        return new Response("Forbidden", { status: 403 });
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          subscribers.add(c);
          c.enqueue(
            encoder.encode(
              `event: progress\ndata: ${fragment().replace(/\n/g, "\ndata: ")}\n\n`,
            ),
          );
          if (healthy)
            c.enqueue(encoder.encode("event: ready\ndata: ready\n\n"));
        },
        cancel() {
          subscribers.delete(controller);
        },
      });
      const headers = new Headers({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (origin) {
        headers.set("access-control-allow-origin", origin);
        headers.set("vary", "Origin");
      }
      return new Response(stream, { headers });
    }
    if (request.method === "POST") {
      if (!allowedOrigin(request))
        return new Response("Forbidden", { status: 403 });
      if (url.pathname === "/local") {
        persisted.accessMode = "localhost"; remoteRequested = false; await persist(); emit("access", "changed");
        return Response.redirect(url.origin, 303);
      }
      if (url.pathname === "/connect") {
        remoteRequested = true;
        if (stopping) return new Response("System is stopping", { status: 503 });
        if (connectionAttempt !== "running") {
          connectionAttempt = "idle";
          connectionFailure = undefined;
          networkError = undefined;
          connectionStateSince = lastNetworkSuccess = Date.now();
        }
        return request.headers.get("accept")?.includes("text/html") ? Response.redirect(url.origin, 303) : new Response(null, { status: 202 });
      }
      if (!initialized || stopping)
        return new Response("System is starting or stopping", { status: 503 });
      if (busy)
        return new Response("An operation is already running", { status: 409 });
      if (url.pathname === "/retry") {
        activeOperation = replace(candidate, !persisted.currentImage);
        return Response.redirect(
          request.headers.get("origin") ?? url.origin,
          303,
        );
      }
      if (url.pathname === "/update") {
        const body: unknown = await request.json().catch(() => null);
        if (
          !Value.Check(Type.Object({ image: Type.String({ minLength: 1, pattern: "^(?!-)[^\\s]+$" }) }), body)
        )
          return new Response("Expected image reference", { status: 400 });
        // Reserve the operation across asynchronous validation; reject invalid requests
        // before interrupting the healthy app.
        if (busy || stopping)
          return new Response(
            "An operation is already running or System is stopping",
            { status: 409 },
          );
        busy = true;
        let exact: string;
        try {
          exact = await prepareImage(body.image, false);
        } catch (error) {
          busy = false;
          return new Response(String(error), { status: 400 });
        }
        if (stopping) {
          busy = false;
          return new Response("System is stopping", { status: 503 });
        }
        const previouslyHealthy = healthy;
        healthy = false;
        try {
          await configureRoutes(3001);
        } catch (error) {
          healthy = previouslyHealthy;
          busy = false;
          return new Response(String(error), { status: 502 });
        }
        // Route first, acknowledge, then give the app time to relay that acknowledgement.
        // Replacement remains supervisor-owned if the requesting browser disconnects.
        activeOperation = (async () => {
          await Bun.sleep(1000);
          busy = false;
          if (!stopping) await replace(exact, false);
        })();
        return Response.json({ accepted: true }, { status: 202 });
      }
    }
    if (url.pathname === "/client.js" || url.pathname === "/design-system.css")
      return new Response(
        Bun.file(new URL(`.${url.pathname}`, import.meta.url)),
        { headers: { "access-control-allow-origin": "*" } },
      );
    // Tailscale preserves the app path when routing this origin to the supervisor.
    // Open workspace tabs must reach progress rather than a missing app route.
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Not found", { status: 404 });
    if (url.pathname !== "/")
      return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
    const diagnostic = url.port === "8443" || url.hostname === "system.atelier.localhost";
    const local = url.hostname.endsWith(".localhost");
    const events = local ? `${url.protocol}//system.atelier.localhost:${url.port}/events` : tailnetHost
      ? `https://${tailnetHost}:8443/events`
      : "/events";
    return new Response(
      page(
        "Atelier System",
        `<section data-controller="progress" data-progress-events-value="${escape(events)}" data-progress-return-value="${!diagnostic && (local || !!tailnetHost)}"><div data-progress-content>${fragment()}</div></section>`,
        local ? "" : tailnetHost ? `https://${tailnetHost}:8443` : "",
      ),
      { headers: { "content-type": "text/html" } },
    );
  },
});
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  healthy = false;
  stage("Stopping Atelier services");
  stopCommands();
  await startup;
  await activeOperation;
  await routing.catch((error) => log(String(error)));
  try {
    const running = (await docker("ps", "-q", "--filter", "name=^atelier$"))
      .split("\n")
      .filter(Boolean);
    const all = (await docker("ps", "-q")).split("\n").filter(Boolean);
    persisted.runningContainers = [
      ...new Set([
        ...(persisted.runningContainers ?? []),
        ...all.filter((id) => !running.includes(id)),
      ]),
    ];
    await persist();
    if (all.length) await docker("stop", "--time", "20", ...all);
  } catch (error) {
    log(String(error));
    code = 1;
  }
  logProcess?.kill();
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      sleep(15000),
    ]);
  }
  localIngress.stop(true);
  server.stop(true);
  process.exit(code);
}
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("SIGINT", () => {
  void shutdown(0);
});
async function initialize() {
  await installWorkspaceFirewall();
  daemon(["containerd", "--config", "/etc/containerd/config.toml"]);
  await waitFor(
    async () => {
      try {
        await command(["ctr", "version"]);
        return true;
      } catch {
        return false;
      }
    },
    30000,
    "containerd",
  );
  daemon(["dockerd", "--config-file", "/run/atelier-system/daemon.json"]);
  daemon([
    "tailscaled",
    "--state=/data/tailscale/tailscaled.state",
    "--socket=/var/run/tailscale/tailscaled.sock",
  ]);
  await waitFor(
    async () => {
      try {
        await docker("info");
        return true;
      } catch {
        return false;
      }
    },
    60000,
    "Docker",
  );
  for (const id of persisted.runningContainers ?? []) await docker("start", id);
  persisted.runningContainers = [];
  await persist();
  // Tailscale login may happen after app boot. Its network state is independent.
  void (async () => {
    connectionStateSince = lastNetworkSuccess = Date.now();
    let lastAccess = "";
    while (!stopping) {
      try {
        const status = JSON.parse(
          await command(["tailscale", "status", "--json"], undefined, 5000),
        );
        if (status.BackendState !== connectionState) connectionStateSince = Date.now();
        connectionState = status.BackendState;
        authUrl = status.AuthURL || undefined;
        if (remoteRequested && connectionAttempt === "idle" &&
            (connectionState === "NeedsLogin" || connectionState === "Stopped")) {
          connectionAttempt = "running";
          // The browser sign-in is the user's consent; generating its URL does
          // not connect an account. System owns this command and its deadline.
          void command(["tailscale", "up", "--timeout=10m"], log, 610_000)
            .catch((error) => {
              connectionFailure = `Could not connect Atelier: ${String(error)}`;
              log(connectionFailure);
            }).finally(() => { connectionAttempt = "finished"; });
        }
        const host =
          status.BackendState === "Running"
            ? status.Self.DNSName.replace(/\.$/, "")
            : undefined;
        if (host) {
          const changed = host !== tailnetHost;
          tailnetHost = host;
          if (remoteRequested && persisted.accessMode !== "tailscale") { persisted.accessMode = "tailscale"; await persist(); emit(); }
          await configureRoutes(routeTarget);
          if (changed) log(`Tailscale ready: https://${host}`);
        } else {
          tailnetHost = undefined;
          appliedRoute = "";
        }
        lastNetworkSuccess = Date.now();
        networkError = undefined;
        if (host) connectionFailure = undefined;
      } catch (error) {
        networkError = String(error);
        log(`Tailscale: ${networkError}`);
      }
      const nextAccess = JSON.stringify([persisted.accessMode, connectionState, authUrl, connectionFailure, networkError]);
      if (nextAccess !== lastAccess) { lastAccess = nextAccess; emit("access", "changed"); }
      await sleep(3000);
    }
  })();
  if (stopping) return;
  if (persisted.accessMode === "localhost") await waitFor(async () => !!persisted.localPort, 60000, "installer to register the local port");
  initialized = true;
  activeOperation = replace(candidate, !persisted.currentImage);
  void (async () => {
    while (!stopping) {
      await sleep(3000);
      if (!healthy || busy || stopping) continue;
      const ready = await appIsHealthy();
      if (!ready && healthy && !busy && !stopping) {
        healthy = false;
        failure = "Atelier stopped responding to health checks";
        stage("Atelier needs attention");
        try {
          await configureRoutes(3001);
        } catch (error) {
          log(String(error));
        }
      }
    }
  })();
}
startup = initialize().catch((error) => {
  if (!stopping) {
    log(String(error));
    void shutdown(1);
  }
});
