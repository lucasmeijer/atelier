import { escapeHtml } from "@atelier/shared";
import { replacementCreateArgs, dockerExec, dockerContainerInspect, serverHealthUrlFromInspect } from "./docker.ts";
import { updaterPort } from "./constants.ts";
import { isReleaseChannel, type ReleaseChannel } from "./channels.ts";

interface Options { serverContainer: string; targetImage: string; releaseChannel: ReleaseChannel; returnUrl: string }
interface Step { id: string; label: string; status: "pending" | "running" | "done" | "failed"; log?: string }

function parseArgs(argv: string[]): Options {
  const out: Partial<Options> = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--server-container") out.serverContainer = argv[++i];
    else if (argv[i] === "--target-image") out.targetImage = argv[++i];
    else if (argv[i] === "--release-channel") {
      const channel = argv[++i];
      if (!isReleaseChannel(channel)) throw new Error(`unsupported release channel: ${channel}`);
      out.releaseChannel = channel;
    } else if (argv[i] === "--return-url") out.returnUrl = argv[++i];
    else if (argv[i] === "--return-host") out.returnUrl = `http://${argv[++i]}/`;
  }
  if (!out.serverContainer || !out.targetImage || !out.returnUrl) throw new Error("missing update helper arguments");
  return {
    serverContainer: out.serverContainer,
    targetImage: out.targetImage,
    returnUrl: out.returnUrl,
    releaseChannel: out.releaseChannel ?? (out.targetImage.endsWith(":latest") ? "latest" : "stable"),
  };
}

const options = parseArgs(Bun.argv.slice(2));
const steps: Step[] = [
  { id: "prepare", label: "Preparing update", status: "pending" },
  { id: "stop", label: "Stopping Atelier", status: "pending" },
  { id: "start", label: "Starting Atelier", status: "pending" },
  { id: "wait", label: "Waiting for Atelier", status: "pending" },
  { id: "redirect", label: "Redirecting", status: "pending" },
];
let failed = false;
let started = false;

function setStep(id: string, status: Step["status"], log?: string): void {
  const step = steps.find((candidate) => candidate.id === id)!;
  step.status = status;
  if (log) step.log = log;
}

const stepPresentation = {
  pending: { marker: "○", rowAttributes: ' role="checkbox" aria-checked="false"', markerAttributes: "" },
  running: { marker: "", rowAttributes: ' aria-busy="true"', markerAttributes: "" },
  done: { marker: "✓", rowAttributes: ' role="checkbox" aria-checked="true"', markerAttributes: "" },
  failed: { marker: "✕", rowAttributes: ' data-status="failed"', markerAttributes: ' role="img" aria-label="Failed"' },
} satisfies Record<Step["status"], { marker: string; rowAttributes: string; markerAttributes: string }>;

function page(theme: string): string {
  const stepHtml = steps.map((step) => {
    const presentation = stepPresentation[step.status];
    return `<li class="status-list__item"${presentation.rowAttributes}><span class="status-list__marker"${presentation.markerAttributes}>${presentation.marker}</span><div class="update-helper__step"><b>${step.label}</b>${step.log ? `<pre>${escapeHtml(step.log)}</pre>` : ""}</div></li>`;
  }).join("");
  return `<!DOCTYPE html><html data-theme="${escapeHtml(theme || "nord")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Updating Atelier</title><link rel="stylesheet" href="/design-system.css"><style>*{box-sizing:border-box}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:var(--space-xl);background:var(--bg);color:var(--text);font:var(--text-body)/var(--leading-standard) var(--font-sans)}.update-helper{width:min(620px,100%)}.update-helper .dialog__header{padding-bottom:0}.update-helper__step{min-width:0;flex:1}.update-helper pre{max-height:220px;margin:var(--space-md) 0 0;padding:var(--space-lg);overflow:auto;border:1px solid var(--line);border-radius:var(--radius-surface);background:var(--bg);color:var(--text);font:var(--text-small)/var(--leading-standard) var(--font-mono);white-space:pre-wrap}</style><script>setInterval(async()=>{const r=await fetch('/state');const s=await r.json();if(s.redirect) location.href=s.redirect; else location.reload();},1200)</script></head><body><main class="dialog update-helper"><header class="dialog__header"><h1 class="title">Updating Atelier</h1></header><div class="dialog__body"><p>${failed ? "The update needs attention. The logs below should help you recover over SSH." : "Atelier is restarting. This usually takes a few seconds."}</p><ol class="status-list">${stepHtml}</ol></div></main></body></html>`;
}

function startUpdate(): void {
  if (started) return;
  started = true;
  void run();
}

async function run(): Promise<void> {
  try {
    setStep("prepare", "running");
    const inspect = await dockerContainerInspect(options.serverContainer);
    const image = await dockerExec(["image", "inspect", options.targetImage]);
    if (image.code !== 0) throw new Error(`${options.targetImage} is not present locally`);
    setStep("prepare", "done");

    setStep("stop", "running");
    const stop = await dockerExec(["stop", options.serverContainer]);
    if (stop.code !== 0) throw new Error(stop.stderr || "docker stop failed");
    const remove = await dockerExec(["rm", options.serverContainer]);
    if (remove.code !== 0) throw new Error(remove.stderr || "docker rm failed");
    setStep("stop", "done");

    setStep("start", "running");
    const createArgs = replacementCreateArgs({ ...inspect, Config: { ...inspect.Config, Image: options.targetImage } }, options.targetImage, options.releaseChannel);
    const create = await dockerExec(createArgs);
    if (create.code !== 0) throw new Error(create.stderr || "docker create failed");
    const start = await dockerExec(["start", (inspect.Name ?? "atelier").replace(/^\//, "")]);
    if (start.code !== 0) throw new Error(start.stderr || "docker start failed");
    setStep("start", "done");

    setStep("wait", "running");
    const healthUrl = serverHealthUrlFromInspect(inspect, options.returnUrl);
    while (true) {
      const up = await fetch(healthUrl).catch(() => undefined);
      if (up?.ok) { setStep("wait", "done"); setStep("redirect", "running"); return; }
      await Bun.sleep(1000);
    }
  } catch (error) {
    failed = true;
    const running = steps.find((step) => step.status === "running");
    if (running) setStep(running.id, "failed", error instanceof Error ? error.message : String(error));
  }
}

Bun.serve({
  hostname: "127.0.0.1",
  port: updaterPort,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/up") return new Response("ok", { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/state") return Response.json({ failed, redirect: steps.find((s) => s.id === "redirect")?.status === "running" ? options.returnUrl : undefined, steps });
    if (url.pathname === "/design-system.css") return new Response(Bun.file("/app/apps/web/public/design-system.css"), { headers: { "content-type": "text/css; charset=utf-8" } });
    if (url.pathname === "/fonts/jetbrains-mono-latin-400-normal.woff2") return new Response(Bun.file("/app/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"), { headers: { "content-type": "font/woff2" } });
    if (url.pathname === "/") startUpdate();
    return new Response(page(url.searchParams.get("theme") ?? ""), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
});

// A closed tab or crashed browser must not leave a healthy helper waiting forever.
// This grace period still gives the restart response time to deliver its redirect.
setTimeout(startUpdate, 10_000);
