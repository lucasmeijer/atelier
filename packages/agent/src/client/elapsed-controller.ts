import type { WorkspaceClientControllerConstructor as StimulusControllerConstructor } from "@atelier/shared";

export function createAgentElapsedController(Controller: StimulusControllerConstructor) {
  return class AgentElapsedController extends Controller {
    static values = { since: Number, max: Number };
    static targets = ["time"];
    declare readonly sinceValue: number;
    declare readonly maxValue: number;
    declare readonly hasMaxValue: boolean;
    declare readonly timeTargets: HTMLElement[];
    private timer?: ReturnType<typeof setInterval>;

    connect(): void {
      const format = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60);
        const rest = seconds % 60;
        return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}`;
      };
      const update = () => {
        const seconds = Math.max(0, Math.round((Date.now() - this.sinceValue) / 1000));
        const max = this.hasMaxValue && this.maxValue > 0 ? ` / ${format(this.maxValue)}` : "";
        for (const target of this.timeTargets) target.textContent = `${format(seconds)}${max}`;
      };
      update();
      this.timer = setInterval(update, 1000);
    }

    disconnect(): void {
      if (this.timer) clearInterval(this.timer);
    }
  };
}

