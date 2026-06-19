/// <reference lib="dom" />

type StimulusControllerBase = new (...args: unknown[]) => { element: Element };

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

export function installKeypressProbe(): void {
  if (document.documentElement.dataset.keypressProbeInstalled === "true") return;
  document.documentElement.dataset.keypressProbeInstalled = "true";
  (["keydown", "keypress", "keyup"] as const).forEach((type) => {
    window.addEventListener(type, (event) => {
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
    }, true);
  });
}

export function createKeypressProbeController(Controller: StimulusControllerBase): unknown {
  return class KeypressProbeController extends Controller {
    static targets = ["list", "count"];
    declare readonly listTarget: HTMLOListElement;
    declare readonly hasListTarget: boolean;
    declare readonly countTarget: HTMLElement;
    declare readonly hasCountTarget: boolean;
    private count = 0;

    connect(): void {
      document.addEventListener("atelier:keypress-probe", this.record as EventListener);
    }

    disconnect(): void {
      document.removeEventListener("atelier:keypress-probe", this.record as EventListener);
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
      item.innerHTML = `<b>${this.escape(detail.combo)}</b> <span>${this.escape(detail.type)}</span><small>key=${this.escape(detail.key)} code=${this.escape(detail.code)}${detail.repeat ? " repeat" : ""}${detail.isComposing ? " composing" : ""}${detail.defaultPrevented ? " prevented" : ""} · ${this.escape(detail.target)}</small>`;
      this.listTarget.prepend(item);
      while (this.listTarget.children.length > 8) this.listTarget.lastElementChild?.remove();
    };

    private renderEmpty(): void {
      if (this.hasCountTarget) this.countTarget.textContent = "0";
      if (this.hasListTarget) this.listTarget.innerHTML = `<li class="empty">Press keys… browser/iframe-reserved combos will not appear.</li>`;
    }

    private escape(value: string): string {
      return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
    }
  };
}
