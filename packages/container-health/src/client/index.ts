/// <reference lib="dom" />

type StimulusControllerConstructor = new (...args: unknown[]) => { element: Element };

declare global {
  interface Window {
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

interface HealthGraphPayload {
  cpu: number;
  memory: number;
  network: number;
  block: number;
  labels: Record<string, string>;
}

interface HealthEventPayload {
  streams?: string;
  graph?: HealthGraphPayload;
}

export function createContainerHealthController(Controller: StimulusControllerConstructor): unknown {
  return class ContainerHealthController extends Controller {
    static values = { workspaceId: String, streamUrl: String };
    declare readonly element: HTMLElement;
    declare readonly streamUrlValue: string;
    declare readonly hasStreamUrlValue: boolean;
    private source?: EventSource;
    private series = new Map<string, number[]>();

    connect(): void {
      if (!this.hasStreamUrlValue || this.source) return;
      this.source = new EventSource(this.streamUrlValue);
      this.source.addEventListener("health", this.health);
      this.source.onerror = () => this.markDisconnected();
    }

    disconnect(): void {
      this.source?.close();
      this.source = undefined;
    }

    private health = (event: MessageEvent<string>): void => {
      const payload = JSON.parse(event.data) as HealthEventPayload;
      if (payload.streams) window.Turbo?.renderStreamMessage(payload.streams);
      if (payload.graph) this.updateGraphs(payload.graph);
    };

    private updateGraphs(payload: HealthGraphPayload): void {
      this.plot("cpu", payload.cpu, 100, payload.labels.cpu);
      this.plot("memory", payload.memory, 100, payload.labels.memory);
      this.plot("network", payload.network, undefined, payload.labels.network);
      this.plot("block", payload.block, undefined, payload.labels.block);
    }

    private plot(key: string, value: number, fixedMax: number | undefined, label: string): void {
      const values = this.series.get(key) ?? [];
      values.push(Math.max(0, Number.isFinite(value) ? value : 0));
      while (values.length > 60) values.shift();
      this.series.set(key, values);
      const max = fixedMax ?? Math.max(1, ...values) * 1.15;
      const line = this.path(values, max, false);
      const fill = this.path(values, max, true);
      this.element.querySelector<SVGPathElement>(`[data-health-graph-line="${CSS.escape(key)}"]`)?.setAttribute("d", line);
      this.element.querySelector<SVGPathElement>(`[data-health-graph-fill="${CSS.escape(key)}"]`)?.setAttribute("d", fill);
      const labelElement = this.element.querySelector<HTMLElement>(`[data-health-graph-value="${CSS.escape(key)}"]`);
      if (labelElement) labelElement.textContent = label;
    }

    private path(values: number[], max: number, fill: boolean): string {
      const width = 120;
      const height = 42;
      if (values.length === 0) return "";
      const points = values.map((value, index) => {
        const x = values.length === 1 ? width : (index / (values.length - 1)) * width;
        const y = height - Math.min(1, value / Math.max(max, 1)) * (height - 4) - 2;
        return [x, y] as const;
      });
      const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
      return fill ? `${line} L ${width} ${height} L 0 ${height} Z` : line;
    }

    private markDisconnected(): void {
      const badge = this.element.querySelector<HTMLElement>(".health-connection");
      if (!badge) return;
      badge.classList.remove("live");
      badge.classList.add("error");
      badge.textContent = "Reconnecting…";
    }
  };
}
