import { createLaunchModelRefreshController, createAgentModelSetupController } from "./model-setup-controllers.ts";
import type { WorkspaceClientModule, WorkspaceClientControllerConstructor } from "@atelier/shared";

function createOAuthFlowController(Controller: WorkspaceClientControllerConstructor) {
  return class OAuthFlowController extends Controller {
    declare readonly element: HTMLElement;
    static values = { statusUrl: String, active: Boolean, pollMs: Number };
    declare readonly statusUrlValue: string;
    declare readonly activeValue: boolean;
    declare readonly pollMsValue: number;
    declare readonly hasPollMsValue: boolean;
    private timer: number | undefined;
    private polling = false;

    connect(): void {
      if (!this.activeValue || !this.statusUrlValue) return;
      this.timer = window.setInterval(() => void this.poll(), this.hasPollMsValue ? this.pollMsValue : 3000);
      window.addEventListener("focus", this.pollSoon);
      document.addEventListener("visibilitychange", this.pollIfVisible);
    }

    disconnect(): void {
      if (this.timer !== undefined) window.clearInterval(this.timer);
      window.removeEventListener("focus", this.pollSoon);
      document.removeEventListener("visibilitychange", this.pollIfVisible);
    }

    private pollSoon = (): void => {
      window.setTimeout(() => void this.poll(), 100);
    };

    private pollIfVisible = (): void => {
      if (document.visibilityState === "visible") void this.poll();
    };

    private async poll(): Promise<void> {
      if (this.polling) return;
      this.polling = true;
      const response = await fetch(this.statusUrlValue, {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "text/vnd.turbo-stream.html" },
      }).catch(() => undefined);
      this.polling = false;
      if (!response?.ok) return;
      const codeCopied = this.element.dataset.oauthCodeCopied === "true";
      const authenticationStarted = this.element.dataset.oauthAuthenticationStarted === "true";
      const html = await response.text();
      if (!html.trim()) return;
      window.Turbo?.renderStreamMessage(html);
      if (codeCopied || authenticationStarted) window.requestAnimationFrame(() => this.restoreDeviceCodeState(codeCopied, authenticationStarted));
    }

    showDeviceAuth(): void {
      this.element.dataset.oauthCodeCopied = "true";
      this.element.querySelector<HTMLElement>("[data-oauth-device-auth]")!.hidden = false;
    }

    showWaitingStatus(): void {
      this.element.dataset.oauthAuthenticationStarted = "true";
      this.element.querySelector<HTMLElement>("[data-oauth-waiting-status]")!.hidden = false;
    }

    private restoreDeviceCodeState(codeCopied: boolean, authenticationStarted: boolean): void {
      const dialog = document.querySelector<HTMLElement>("#model_connection_step");
      const deviceAuth = dialog?.querySelector<HTMLElement>("[data-oauth-device-auth]");
      if (!dialog || !deviceAuth) return;
      if (codeCopied) {
        dialog.dataset.oauthCodeCopied = "true";
        deviceAuth.hidden = false;
      }
      if (authenticationStarted) {
        dialog.dataset.oauthAuthenticationStarted = "true";
        dialog.querySelector<HTMLElement>("[data-oauth-waiting-status]")!.hidden = false;
      }
    }
  };
}

export const atelierClientModule: WorkspaceClientModule = { id: "llm", install({ application, Controller }) { application.register("launch-model-refresh", createLaunchModelRefreshController(Controller)); application.register("agent-model-setup", createAgentModelSetupController(Controller)); application.register("oauth-flow", createOAuthFlowController(Controller)); } };
