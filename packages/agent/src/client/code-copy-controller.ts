import { copyTextToClipboard, type WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentCodeCopyController(Controller: StimulusControllerConstructor) {
  return class AgentCodeCopyController extends Controller {
    static targets = ["button", "code"];
    declare readonly buttonTarget: HTMLButtonElement;
    declare readonly codeTarget: HTMLElement;
    private timer?: ReturnType<typeof setTimeout>;

    disconnect(): void {
      if (this.timer) clearTimeout(this.timer);
    }

    async copy(): Promise<void> {
      const text = this.codeTarget.textContent ?? "";
      if (!text) return;
      await copyTextToClipboard(text);

      if (this.timer) clearTimeout(this.timer);
      const button = this.buttonTarget;
      const icon = button.querySelector<HTMLElement>(".agent-code-copy-icon");
      const label = button.dataset.resetLabel ?? button.getAttribute("aria-label") ?? "Copy code to clipboard";
      button.dataset.resetLabel = label;
      button.classList.add("copied");
      button.setAttribute("aria-label", "Copied code");
      if (icon) icon.textContent = "✓";
      this.timer = setTimeout(() => {
        button.classList.remove("copied");
        button.setAttribute("aria-label", label);
        if (icon) icon.textContent = "⧉";
      }, 1400);
    }
  };
}
