import { Application, Controller } from "@hotwired/stimulus";
import RFB from "@novnc/novnc";

class DesktopController extends Controller {
  static targets = ["screen", "runtime"];
  declare readonly screenTarget: HTMLElement;
  declare readonly runtimeTarget: HTMLElement;
  private phase = "connecting";
  private detail = "";
  private readonly params = new URL(window.location.href).searchParams;
  private rfb?: RFB;
  private retry?: ReturnType<typeof setTimeout>;
  private active = false;
  private request?: AbortController;

  connect(): void {
    this.active = true;
    this.reportRuntime();
    if (this.runtimeTarget.firstElementChild!.getAttribute("data-phase") === "running") this.open();
    else this.scheduleRetry();
  }

  disconnect(): void {
    this.active = false;
    clearTimeout(this.retry);
    this.request?.abort();
    this.rfb?.disconnect();
    this.rfb = undefined;
  }

  receive(event: MessageEvent): void {
    if (event.source !== window.parent || event.origin !== this.params.get("parentOrigin") || event.data?.type !== "atelier:desktop:status-request") return;
    this.report(this.phase, this.detail);
  }

  private report(phase: string, detail = ""): void {
    this.phase = phase;
    this.detail = detail;
    const parentOrigin = this.params.get("parentOrigin");
    if (window.parent !== window && parentOrigin) window.parent.postMessage({ type: "atelier:desktop:status", token: this.params.get("statusToken"), phase, detail }, parentOrigin);
  }

  private reportRuntime(): void {
    const phase = this.runtimeTarget.firstElementChild!.getAttribute("data-phase")!;
    this.report(phase === "running" ? "connecting" : phase, this.runtimeTarget.querySelector(".desktop-status-detail")?.textContent ?? "");
  }

  private open(): void {
    const url = new URL("/websockify", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const rfb = new RFB(this.screenTarget, url.toString());
    this.rfb = rfb;
    rfb.background = getComputedStyle(document.body).backgroundColor;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.showDotCursor = true;
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;
    rfb.addEventListener("connect", () => {
      this.report("connected");
    });
    rfb.addEventListener("disconnect", () => {
      this.rfb = undefined;
      if (!this.active) return;
      this.report("disconnected");
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    this.retry = setTimeout(() => void this.refresh(), 3000);
  }

  private async refresh(): Promise<void> {
    this.request = new AbortController();
    try {
      const response = await fetch("/status", { signal: this.request.signal });
      if (!response.ok) throw new Error(`Desktop status: HTTP ${response.status}`);
      const html = await response.text();
      if (!this.active) return;
      this.runtimeTarget.innerHTML = html;
      this.reportRuntime();
      if (this.runtimeTarget.firstElementChild!.getAttribute("data-phase") === "running") this.open();
      else this.scheduleRetry();
    } catch (error) {
      if (!this.active) return;
      console.error("Desktop connection failed", error);
      this.report("disconnected");
      this.scheduleRetry();
    }
  }
}

Application.start().register("desktop", DesktopController);
