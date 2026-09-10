/// <reference lib="dom" />
import { CableTopics, type CableSubscription, type WorkspaceClientModule } from "@atelier/shared";

export const atelierClientModule: WorkspaceClientModule = {
  id: "project-setup",
  install({ application, Controller }) {
    application.register("setup-request-inbox", class extends Controller {
      declare readonly element: HTMLElement & { reload(): void };
      private subscription?: CableSubscription;
      connect(): void {
        const workspaceId = this.element.getAttribute("data-workspace-id")!;
        this.subscription = window.AtelierCable!.subscribe(CableTopics.workspace(workspaceId), {
          onReady: () => {
            // Turbo owns fetching and replacing the server-rendered frame contents.
            this.element.reload();
          },
        });
      }
      disconnect(): void { this.subscription?.unsubscribe(); }
    });
    application.register("setup-request-dialog", class extends Controller {
      declare readonly element: HTMLDialogElement;
      private visibility?: MutationObserver;
      connect(): void {
        const resident = this.element.closest<HTMLElement>(".workspace-detail-resident");
        const sync = () => {
          const visible = !resident || resident.classList.contains("visible");
          if (visible && !this.element.open) this.element.showModal();
          else if (!visible && this.element.open) this.element.close();
        };
        if (resident) {
          this.visibility = new MutationObserver(sync);
          this.visibility.observe(resident, { attributes: true, attributeFilter: ["class"] });
        }
        sync();
      }
      disconnect(): void { this.visibility?.disconnect(); }
      preventDismiss(event: Event): void { event.preventDefault(); }
    });
    application.register("secret-request", class extends Controller {
      connect(): void { this.updateSave(); }
      updateSave(): void {
        const value = this.element.querySelector<HTMLInputElement>('[data-secret-request-target="value"]')!;
        this.element.querySelector<HTMLButtonElement>('[data-secret-request-target="save"]')!.disabled = value.value.length === 0;
      }
      toggleChanged(event: Event): void {
        // SAFETY: The design-system toggle emits a CustomEvent with name and value; native change events have no detail.
        const detail = (event as CustomEvent<{ name?: string; value?: string }>).detail;
        if (detail?.name === "optional") this.element.querySelector<HTMLInputElement>('input[name="optional"]')!.value = detail.value!;
        this.updateSave();
      }
    });
  },
};
