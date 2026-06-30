import { replacementCreateArgs, dockerExec, dockerInspect } from "./docker.ts";
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
  out.releaseChannel ??= out.targetImage.endsWith(":latest") ? "latest" : "stable";
  return out as Options;
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

function setStep(id: string, status: Step["status"], log?: string): void {
  const step = steps.find((candidate) => candidate.id === id)!;
  step.status = status;
  if (log) step.log = log;
}

function page(theme: string): string {
  return `<!DOCTYPE html><html data-theme="${theme || "nord"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Updating Atelier</title><link rel="stylesheet" href="/style.css"><style>body{min-height:100vh;display:grid;place-items:center;background:var(--bg)}.update-helper{width:min(620px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;box-shadow:var(--shadow)}.update-helper h1{margin:0 0 8px}.update-helper p{color:var(--muted)}.update-helper ol{list-style:none;margin:22px 0 0;padding:0;display:grid;gap:12px}.update-helper li{display:flex;gap:12px;align-items:flex-start}.dot{width:13px;height:13px;border-radius:50%;margin-top:3px;background:var(--line)}li.running .dot{background:var(--accent);box-shadow:0 0 0 5px var(--accent-soft)}li.done .dot{background:var(--green)}li.failed .dot{background:var(--red)}pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px;max-height:220px;overflow:auto}</style><script>setInterval(async()=>{const r=await fetch('/state');const s=await r.json();if(s.redirect) location.href=s.redirect; else location.reload();},1200)</script></head><body><main class="update-helper"><h1>Updating Atelier</h1><p>${failed ? "The update needs attention. The logs below should help you recover over SSH." : "Atelier is restarting. This usually takes a few seconds."}</p><ol>${steps.map((s)=>`<li class="${s.status}"><span class="dot"></span><div><b>${s.label}</b>${s.log?`<pre>${s.log.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]!))}</pre>`:""}</div></li>`).join("")}</ol></main></body></html>`;
}

async function run(): Promise<void> {
  try {
    setStep("prepare", "running");
    const inspect = await dockerInspect(options.serverContainer);
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
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const up = await fetch(new URL("/up", options.returnUrl)).catch(() => undefined);
      if (up?.ok) { setStep("wait", "done"); setStep("redirect", "running"); return; }
      await Bun.sleep(1000);
    }
    throw new Error("Atelier did not become healthy within 120 seconds");
  } catch (error) {
    failed = true;
    const running = steps.find((step) => step.status === "running");
    if (running) setStep(running.id, "failed", error instanceof Error ? error.message : String(error));
  }
}

Bun.serve({
  port: updaterPort,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/up") return new Response("ok", { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/state") return Response.json({ failed, redirect: steps.find((s) => s.id === "redirect")?.status === "running" ? options.returnUrl : undefined, steps });
    if (url.pathname === "/style.css") return new Response(Bun.file("/app/apps/web/public/style.css"), { headers: { "content-type": "text/css; charset=utf-8" } });
    return new Response(page(url.searchParams.get("theme") ?? ""), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  },
});

void run();
