// Docker's non-TTY pull output reports layer discovery and completion, not
// byte totals. Report counts, not a misleading download percentage.
export class PullProgress {
  private pending = "";
  private layers = new Map<string, boolean>();

  push(chunk: string) {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop()!;
    for (const line of lines) {
      const match = /^([a-f0-9]+): (Pulling fs layer|Already exists|Pull complete)$/.exec(line.trim());
      if (match) this.layers.set(match[1]!, match[2] !== "Pulling fs layer");
    }
    if (this.layers.size === 0) return undefined;
    return { completed: [...this.layers.values()].filter(Boolean).length, total: this.layers.size };
  }
}
