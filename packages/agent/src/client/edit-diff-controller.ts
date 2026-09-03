import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentEditDiffController(Controller: StimulusControllerConstructor) {
  return class AgentEditDiffController extends Controller {
    static targets = ["model"];
    declare readonly modelTarget: HTMLScriptElement;
    private instances: Array<{ cleanUp(): void }> = [];

    connect(): void { void this.render(); }

    disconnect(): void {
      for (const instance of this.instances) instance.cleanUp();
      this.instances = [];
    }

    private async render(): Promise<void> {
      const [{ FileDiff }, { toolDiffOptions }] = await Promise.all([import("@pierre/diffs"), import("@atelier/syntax/pierre")]);
      if (!this.element.isConnected) return;
      // SAFETY: This private script is serialized by editDiffHtml from FileDiffMetadata[].
      const diffs = JSON.parse(this.modelTarget.textContent ?? "[]") as Array<import("@pierre/diffs").FileDiffMetadata>;
      const containers = [...this.element.querySelectorAll<HTMLElement>("diffs-container")];
      for (const [index, fileDiff] of diffs.entries()) {
        const instance = new FileDiff(toolDiffOptions);
        instance.render({ fileContainer: containers[index]!, fileDiff });
        this.instances.push(instance);
      }
    }
  };
}
