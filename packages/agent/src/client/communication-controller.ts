import type { WorkspaceClientControllerConstructor } from "@atelier/shared";

const expandedMessages = new Map<string, boolean>();

/** Keep disclosure state when a delivery update replaces the incoming-message row. */
export function createCommunicationController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { key: String };
    declare readonly keyValue: string;
    declare readonly element: HTMLDetailsElement;

    connect(): void {
      const open = expandedMessages.get(this.keyValue);
      if (open !== undefined) this.element.open = open;
    }
    remember(): void { expandedMessages.set(this.keyValue, this.element.open); }
    disconnect(): void { this.remember(); }
  };
}
