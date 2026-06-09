import type { AgentRenderOp } from "../shared/protocol.ts";

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

type StimulusApplication = {
  getControllerForElementAndIdentifier(element: Element, identifier: string): unknown;
};

export interface AgentChatControllerInstance {
  start(): void;
}

export function createAgentChatController(Controller: StimulusControllerConstructor) {
  return class AgentChatController extends Controller implements AgentChatControllerInstance {
    static values = { workspaceId: String, label: String, autostart: Boolean };
    static targets = ["transcript", "input", "submitButton"];
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly labelValue: string;
    declare readonly autostartValue: boolean;
    declare readonly transcriptTarget: HTMLElement;
    declare readonly inputTarget: HTMLTextAreaElement;
    declare readonly submitButtonTarget: HTMLButtonElement;
    private ws?: WebSocket;

    connect(): void {
      if (this.autostartValue || this.element.closest(".tab-pane")?.classList.contains("active")) this.start();
      this.inputTarget.addEventListener("keydown", this.keydown);
    }

    disconnect(): void {
      this.inputTarget.removeEventListener("keydown", this.keydown);
      this.ws?.close();
    }

    start(): void {
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.labelValue)}/ws`);
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        this.applyOp(JSON.parse(event.data) as AgentRenderOp);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = undefined;
      };
      ws.onerror = () => this.notice("error", "agent websocket error");
      this.ws = ws;
    }

    submit(event: Event): void {
      event.preventDefault();
      this.start();
      const text = this.inputTarget.value;
      if (!text.trim()) return;
      this.inputTarget.value = "";
      this.ws?.send(JSON.stringify({ type: "submit", text }));
    }

    private keydown = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.element.querySelector("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      }
    };

    private applyOp(op: AgentRenderOp): void {
      const nearBottom = this.transcriptTarget.scrollTop + this.transcriptTarget.clientHeight >= this.transcriptTarget.scrollHeight - 80;
      if (op.type === "replace_html") document.getElementById(op.target)?.replaceChildren(fragmentFromHtml(op.html));
      if (op.type === "append_html") document.getElementById(op.target)?.insertAdjacentHTML("beforeend", op.html);
      if (op.type === "append_text") document.getElementById(op.target)?.append(document.createTextNode(op.text));
      if (op.type === "set_submit_label") {
        this.submitButtonTarget.textContent = op.label;
        this.submitButtonTarget.disabled = Boolean(op.disabled);
      }
      if (op.type === "notice") this.notice(op.level, op.message);
      if (nearBottom) this.transcriptTarget.scrollTop = this.transcriptTarget.scrollHeight;
    }

    private notice(level: "info" | "error", message: string): void {
      const div = document.createElement("div");
      div.className = `agent-notice ${level}`;
      div.textContent = message;
      this.transcriptTarget.append(div);
    }
  };
}

export function startAgentTab(application: StimulusApplication, tabName: string): void {
  if (!tabName.startsWith("agent:")) return;
  const pane = document.querySelector<HTMLElement>(`.tab-pane[data-tab-pane="${CSS.escape(tabName)}"] [data-controller~="agent-chat"]`);
  const controller = pane ? application.getControllerForElementAndIdentifier(pane, "agent-chat") as AgentChatControllerInstance | null : null;
  controller?.start();
}

function fragmentFromHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}
