import type { EditableFileResponse, FileSaveRequest } from "./protocol.ts";

export type SaveResult = { revision: string } | { conflict: EditableFileResponse };
type SaveFile = (request: FileSaveRequest) => Promise<SaveResult>;

// A draft belongs to a file, not to an editor element. One writer serializes
// requests so a later edit always uses the preceding save's revision.
export class FileDraft {
  content: string;
  savedContent: string;
  revision: string;
  conflict?: EditableFileResponse;
  error?: string;
  saving = false;
  private pending?: Promise<void>;
  readonly listeners = new Set<() => void>();

  constructor(file: EditableFileResponse, private readonly write: SaveFile) {
    this.content = this.savedContent = file.content;
    this.revision = file.revision;
  }

  get dirty(): boolean { return this.content !== this.savedContent; }

  edit(content: string): void {
    this.content = content;
    this.notify();
  }

  accept(file: EditableFileResponse): void {
    this.content = this.savedContent = file.content;
    this.revision = file.revision;
    this.conflict = undefined;
    this.error = undefined;
    this.notify();
  }

  changedOnDisk(file: EditableFileResponse): void {
    if (this.saving || file.revision === this.revision) return;
    if (!this.dirty || file.content === this.content) this.accept(file);
    else { this.conflict = file; this.notify(); }
  }

  flush(force = false): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.save(force).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async save(force: boolean): Promise<void> {
    this.error = undefined;
    if (force) this.conflict = undefined;
    if (this.conflict) return;
    this.saving = true;
    this.notify();
    try {
      while (force || this.dirty) {
        const content = this.content;
        const result = await this.write({ content, revision: this.revision, force });
        if ("conflict" in result) { this.conflict = result.conflict; break; }
        this.revision = result.revision;
        this.savedContent = content;
        force = false;
        this.notify();
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
      this.notify();
    }
  }

  private notify(): void { for (const listener of this.listeners) listener(); }
}
