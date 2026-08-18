/// <reference lib="dom" />

import { escapeHtml, type WorkspaceClientControllerConstructor, type WorkspaceClientModule } from "@atelier/shared";

export type KeypressProbeDetail = {
  type: string;
  combo: string;
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  isComposing: boolean;
  defaultPrevented: boolean;
  target: string;
  time: string;
};

function describeKeyTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return String(target?.constructor?.name ?? "unknown");
  const tag = target.tagName.toLowerCase();
  const id = target.id ? `#${target.id}` : "";
  const klass = [...target.classList].slice(0, 2).map((name) => `.${name}`).join("");
  return `${tag}${id}${klass}`;
}

function keyCombo(event: KeyboardEvent): string {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  if (event.shiftKey) parts.push("Shift");
  const key = event.code || event.key || "Unidentified";
  if (!["ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"].includes(key)) parts.push(key);
  return parts.join("+") || key;
}

const eventTypes = ["keydown", "keypress", "keyup"] as const;
type KeypressProbeEventType = typeof eventTypes[number];

let activeProbeControllers = 0;
let installedListeners: Array<{ type: KeypressProbeEventType; listener: (event: KeyboardEvent) => void }> = [];

function installKeypressProbe(): void {
  if (installedListeners.length > 0) return;
  installedListeners = eventTypes.map((type) => {
    const listener = (event: KeyboardEvent) => {
      const detail: KeypressProbeDetail = {
        type,
        combo: keyCombo(event),
        key: event.key,
        code: event.code,
        location: event.location,
        repeat: event.repeat,
        isComposing: event.isComposing,
        defaultPrevented: false,
        target: describeKeyTarget(event.target),
        time: new Date().toLocaleTimeString(),
      };
      window.setTimeout(() => {
        detail.defaultPrevented = event.defaultPrevented;
        document.dispatchEvent(new CustomEvent<KeypressProbeDetail>("atelier:keypress-probe", { detail }));
      }, 0);
    };
    window.addEventListener(type, listener, true);
    return { type, listener };
  });
}

function uninstallKeypressProbe(): void {
  for (const { type, listener } of installedListeners) window.removeEventListener(type, listener, true);
  installedListeners = [];
}

function createKeypressProbeController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class KeypressProbeController extends Controller {
    static targets = ["list", "count"];
    declare readonly listTarget: HTMLOListElement;
    declare readonly hasListTarget: boolean;
    declare readonly countTarget: HTMLElement;
    declare readonly hasCountTarget: boolean;
    private count = 0;

    connect(): void {
      activeProbeControllers += 1;
      installKeypressProbe();
      document.addEventListener("atelier:keypress-probe", this.record as EventListener);
    }

    disconnect(): void {
      document.removeEventListener("atelier:keypress-probe", this.record as EventListener);
      activeProbeControllers -= 1;
      if (activeProbeControllers === 0) uninstallKeypressProbe();
    }

    clear(): void {
      this.count = 0;
      this.renderEmpty();
    }

    private readonly record = (event: CustomEvent<KeypressProbeDetail>): void => {
      if (!this.hasListTarget) return;
      this.count += 1;
      if (this.hasCountTarget) this.countTarget.textContent = String(this.count);
      const item = document.createElement("li");
      const detail = event.detail;
      item.className = detail.defaultPrevented ? "prevented" : "";
      item.innerHTML = `<b>${escapeHtml(detail.combo)}</b> <span>${escapeHtml(detail.type)}</span><small>key=${escapeHtml(detail.key)} code=${escapeHtml(detail.code)}${detail.repeat ? " repeat" : ""}${detail.isComposing ? " composing" : ""}${detail.defaultPrevented ? " prevented" : ""} · ${escapeHtml(detail.target)}</small>`;
      this.listTarget.prepend(item);
      while (this.listTarget.children.length > 8) this.listTarget.lastElementChild?.remove();
    };

    private renderEmpty(): void {
      if (this.hasCountTarget) this.countTarget.textContent = "0";
      if (this.hasListTarget) this.listTarget.innerHTML = `<li class="empty">Press keys… browser/iframe-reserved combos will not appear.</li>`;
    }

  };
}

const keypressProbeClientModule: WorkspaceClientModule = {
  id: "keypress-probe",
  install({ application, Controller }) {
    application.register("keypress-probe", createKeypressProbeController(Controller));
  },
};

export { keypressProbeClientModule as atelierClientModule };
