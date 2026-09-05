import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKeyedOperationQueue, AtelierCoreError, getAtelierRuntimeContext, isJsonObject, type JsonValue } from "@atelier/core";
import type { WorkspaceWorkViewReference } from "@atelier/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
export type { WorkspaceWorkViewReference } from "@atelier/shared";

/** Resource module contribution and type adapter for one Work view kind. */
export interface WorkspaceWorkViewContribution<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  type: Reference["type"];
  parseReference(value: JsonValue): Reference;
  identity(reference: Reference): string;
}

export interface WorkspaceWorkViewState<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  reference: Reference;
  attention: boolean;
  attentionSequence?: number;
}

export interface WorkspacePresentationStore {
  initialize(workspaceId: string, initialWorkViews?: WorkspaceWorkViewReference[]): Promise<void>;
  listWorkViews(workspaceId: string): Promise<WorkspaceWorkViewState[]>;
  openWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, options?: { after?: WorkspaceWorkViewReference }): Promise<{ opened: boolean }>;
  reorderWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, index: number): Promise<void>;
  requestAttention(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<number>;
  acknowledgeAttention(workspaceId: string, reference: WorkspaceWorkViewReference, attentionSequence: number): Promise<boolean>;
  closeWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
}

export interface WorkspacePresentationStoreOptions {
  dataDir?: string;
  workViewContributions: readonly WorkspaceWorkViewContribution[];
}

interface StoredWorkView {
  reference: WorkspaceWorkViewReference;
  attentionSequence?: number;
}

interface StoredPresentation {
  version: 1;
  nextAttentionSequence: number;
  workViews: StoredWorkView[];
}

const presentationFilename = "presentation.json";
const workViewTypeSchema = Type.String();

function presentationError(workspaceId: string, message: string): AtelierCoreError {
  return new AtelierCoreError("workspace_presentation_invalid", `invalid presentation state for workspace ${workspaceId}: ${message}`);
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new AtelierCoreError("invalid_arguments", `invalid workspace id: ${workspaceId}`);
}

export function createWorkspacePresentationStore(options: WorkspacePresentationStoreOptions): WorkspacePresentationStore {
  const dataDir = options.dataDir ?? getAtelierRuntimeContext().atelierDataDir;
  const adapters = new Map(options.workViewContributions.map((adapter) => [adapter.type, adapter]));
  const serialized = createKeyedOperationQueue();

  if (adapters.size !== options.workViewContributions.length) throw new AtelierCoreError("invalid_arguments", "Work view contribution types must be unique");

  function pathFor(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    return join(dataDir, "workspaces", workspaceId, "metadata", presentationFilename);
  }

  function referenceError(workspaceId: string, message: string, stored: boolean): AtelierCoreError {
    return stored
      ? presentationError(workspaceId, message)
      : new AtelierCoreError("work_view_reference_invalid", `invalid Work view reference for workspace ${workspaceId}: ${message}`);
  }

  function parseReference(workspaceId: string, value: JsonValue, stored = false): WorkspaceWorkViewReference {
    if (!isJsonObject(value)) throw referenceError(workspaceId, "reference must be an object", stored);
    const type = value.type;
    if (!Value.Check(workViewTypeSchema, type)) throw referenceError(workspaceId, "reference must have a type", stored);
    const adapter = adapters.get(type);
    if (!adapter) throw referenceError(workspaceId, `unknown Work view type: ${type}`, stored);
    try {
      return adapter.parseReference(value);
    } catch (error) {
      throw referenceError(workspaceId, error instanceof Error ? error.message : String(error), stored);
    }
  }

  function identity(reference: WorkspaceWorkViewReference): string {
    const adapter = adapters.get(reference.type)!;
    return `${reference.type}:${adapter.identity(reference)}`;
  }

  function parse(workspaceId: string, value: JsonValue): StoredPresentation {
    if (!isJsonObject(value)) throw presentationError(workspaceId, "expected version 1 state");
    const { version, nextAttentionSequence, workViews: storedWorkViews } = value;
    if (version !== 1 || !Number.isSafeInteger(nextAttentionSequence) || Number(nextAttentionSequence) < 1 || !Array.isArray(storedWorkViews)) {
      throw presentationError(workspaceId, "expected version 1 state");
    }
    const workViews = storedWorkViews.map((entry, index) => {
      if (!isJsonObject(entry)) throw presentationError(workspaceId, `Work view ${index} must be an object`);
      const reference = parseReference(workspaceId, entry.reference, true);
      const attentionSequence = entry.attentionSequence;
      if (attentionSequence !== undefined && (!Number.isSafeInteger(attentionSequence) || Number(attentionSequence) < 1)) {
        throw presentationError(workspaceId, `Work view ${index} has invalid Attention`);
      }
      const workView: StoredWorkView = { reference };
      if (attentionSequence !== undefined) workView.attentionSequence = Number(attentionSequence);
      return workView;
    });
    const identities = workViews.map(({ reference }) => identity(reference));
    if (new Set(identities).size !== identities.length) throw presentationError(workspaceId, "Work view references must be unique");
    const attentionSequences = workViews.flatMap((view) => view.attentionSequence === undefined ? [] : [view.attentionSequence]);
    if (new Set(attentionSequences).size !== attentionSequences.length || attentionSequences.some((sequence) => sequence >= Number(nextAttentionSequence))) {
      throw presentationError(workspaceId, "Attention sequences are inconsistent");
    }
    return { version: 1, nextAttentionSequence: Number(nextAttentionSequence), workViews };
  }

  async function read(workspaceId: string): Promise<StoredPresentation | undefined> {
    try {
      return parse(workspaceId, JSON.parse(await readFile(pathFor(workspaceId), "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw presentationError(workspaceId, error.message);
      throw error;
    }
  }

  async function write(workspaceId: string, state: StoredPresentation): Promise<void> {
    const path = pathFor(workspaceId);
    await mkdir(join(dataDir, "workspaces", workspaceId, "metadata"), { recursive: true });
    const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    await rename(temporaryPath, path);
  }

  async function requiredState(workspaceId: string): Promise<StoredPresentation> {
    const state = await read(workspaceId);
    if (!state) throw presentationError(workspaceId, "state is missing");
    return state;
  }

  return {
    async initialize(workspaceId, initialWorkViews = []) {
      await serialized(workspaceId, async () => {
        if (await read(workspaceId)) return;
        const state = parse(workspaceId, {
          version: 1,
          nextAttentionSequence: 1,
          workViews: initialWorkViews.map((reference) => ({ reference })),
        });
        await write(workspaceId, state);
      });
    },

    async listWorkViews(workspaceId) {
      return await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        return state.workViews.map((view) => {
          const workView: WorkspaceWorkViewState = { reference: view.reference, attention: view.attentionSequence !== undefined };
          if (view.attentionSequence !== undefined) workView.attentionSequence = view.attentionSequence;
          return workView;
        });
      });
    },

    async openWorkView(workspaceId, inputReference, openOptions = {}) {
      return await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        if (state.workViews.some((view) => identity(view.reference) === identity(reference))) return { opened: false };
        let insertAt = state.workViews.length;
        if (openOptions.after) {
          const after = parseReference(workspaceId, openOptions.after);
          const afterIndex = state.workViews.findIndex((view) => identity(view.reference) === identity(after));
          if (afterIndex < 0) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${identity(after)}`);
          insertAt = afterIndex + 1;
        }
        state.workViews.splice(insertAt, 0, { reference });
        await write(workspaceId, state);
        return { opened: true };
      });
    },

    async reorderWorkView(workspaceId, inputReference, index) {
      await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        if (!Number.isSafeInteger(index) || index < 0 || index >= state.workViews.length) {
          throw new AtelierCoreError("invalid_arguments", `invalid Work view index: ${index}`);
        }
        const reference = parseReference(workspaceId, inputReference);
        const currentIndex = state.workViews.findIndex((view) => identity(view.reference) === identity(reference));
        if (currentIndex < 0) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        if (currentIndex === index) return;
        const [view] = state.workViews.splice(currentIndex, 1);
        state.workViews.splice(index, 0, view!);
        await write(workspaceId, state);
      });
    },

    async requestAttention(workspaceId, inputReference) {
      return await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        const view = state.workViews.find((candidate) => identity(candidate.reference) === identity(reference));
        if (!view) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        view.attentionSequence = state.nextAttentionSequence;
        state.nextAttentionSequence += 1;
        await write(workspaceId, state);
        return view.attentionSequence;
      });
    },

    async acknowledgeAttention(workspaceId, inputReference, attentionSequence) {
      return await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        const view = state.workViews.find((candidate) => identity(candidate.reference) === identity(reference));
        if (!view) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        if (view.attentionSequence !== attentionSequence) return false;
        delete view.attentionSequence;
        await write(workspaceId, state);
        return true;
      });
    },

    async closeWorkView(workspaceId, inputReference) {
      await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        const index = state.workViews.findIndex((candidate) => identity(candidate.reference) === identity(reference));
        if (index < 0) throw new AtelierCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        state.workViews.splice(index, 1);
        await write(workspaceId, state);
      });
    },
  };
}
