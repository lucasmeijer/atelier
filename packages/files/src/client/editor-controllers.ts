import { isWorkspacePaneVisible, type WorkspaceClientApplication, type WorkspaceClientControllerConstructor } from "@atelier/shared";
type EditorPosition = { line: number; column: number };
type EditorRefreshDetail = { workspaceId: string };

function createFileEditorNavigationController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FileEditorNavigationController extends Controller {
    static values = { editor: String, request: String, line: Number, column: Number };
    declare readonly editorValue: string;
    declare readonly lineValue: number;
    declare readonly columnValue: number;
    requestValueChanged(): void {
      // Let the child controller connect before delivering the initial position.
      queueMicrotask(() => {
        const editor = document.getElementById(this.editorValue);
        if (!editor) return; // The surface may have been removed before this callback.
        editor.dataset.fileEditorLineValue = String(this.lineValue);
        editor.dataset.fileEditorColumnValue = String(this.columnValue);
        editor.dispatchEvent(new CustomEvent<EditorPosition>("atelier:file-editor-position", {
          detail: { line: this.lineValue, column: this.columnValue },
        }));
      });
    }
  };
}

function createFilesRefreshSignalController(Controller: WorkspaceClientControllerConstructor): WorkspaceClientControllerConstructor {
  return class FilesRefreshSignalController extends Controller {
    static values = { workspaceId: String, generation: Number };
    declare readonly workspaceIdValue: string;
    generationValueChanged(): void {
      window.dispatchEvent(new CustomEvent<EditorRefreshDetail>("atelier:files-refresh", { detail: { workspaceId: this.workspaceIdValue } }));
    }
  };
}

export function installFileEditorControllers(application: WorkspaceClientApplication, Controller: WorkspaceClientControllerConstructor): void {
  application.register("file-editor-navigation", createFileEditorNavigationController(Controller));
  let loading: Promise<void> | undefined;
  application.register("file-editor", class extends Controller {
    connect(): void {
      document.addEventListener("atelier:workspace-pane-visible", this.activate);
      this.activate();
    }
    disconnect(): void { document.removeEventListener("atelier:workspace-pane-visible", this.activate); }
    private readonly activate = (): void => {
      if (!isWorkspacePaneVisible(this.element)) return;
      loading ??= import("./file-editor.ts").then(({ createFileEditorController }) => {
        application.register("file-editor", createFileEditorController(Controller));
      });
    };
  });
  application.register("files-refresh-signal", createFilesRefreshSignalController(Controller));
}
