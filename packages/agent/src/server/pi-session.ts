import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { shellQuote } from "@atelier/core";
import { execWorkspaceCommand, workspaceRoot } from "@atelier/workspace";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveNewWorkspaceAgentModel } from "./model-state.ts";
import { createPiModelRuntime } from "./pi-config-models.ts";
import type { WorkspaceAgentRuntimeOptions } from "./runtime-types.ts";
import { compactionKeepRecentTokens } from "./runtime-status.ts";
import { AgentServiceTierState, modelRuntimeWithServiceTiers, supportsFastMode, type AgentServiceTier } from "./service-tier.ts";
import type { WorkspaceAgentConversationInfo } from "./session-store.ts";
import { loadWorkspaceSkills } from "./skills.ts";
import { createAtelierResourceLoader } from "./system-prompt.ts";
import { createWorkspaceAgentTools, workspaceAgentToolNames } from "./tools.ts";
import type { AgentToolDefinitionView } from "./render-transcript.ts";

interface InitialSessionSettings {
  model?: NonNullable<Parameters<typeof createAgentSession>[0]>["model"];
  thinkingLevel?: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];
  serviceTier?: AgentServiceTier;
}

async function loadWorkspaceAgentsFiles(workspaceId: string): Promise<Array<{ path: string; content: string }>> {
  const agentsPaths = [`${workspaceRoot}/AGENTS.md`, `${workspaceRoot}/.atelier/AGENTS.md`];
  const agentsFiles: Array<{ path: string; content: string }> = [];

  for (const path of agentsPaths) {
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `if test -s ${shellQuote(path)}; then cat ${shellQuote(path)}; fi`], { workdir: workspaceRoot });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
    if (result.stdout.trim()) agentsFiles.push({ path, content: result.stdout });
  }

  return agentsFiles;
}

const bootstrapOnlySessionEntryTypes = new Set(["model_change", "thinking_level_change"]);
const sessionEntryTypeSchema = Type.Object({ type: Type.String() });

export async function discardBootstrapOnlySession(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return;
  const entries = lines.map((line) => Value.Parse(sessionEntryTypeSchema, JSON.parse(line)));
  if (entries.every((entry) => bootstrapOnlySessionEntryTypes.has(entry.type))) await writeFile(path, "");
}

export async function createPiSession(agent: WorkspaceAgentConversationInfo, options: WorkspaceAgentRuntimeOptions, initial: InitialSessionSettings = {}): Promise<{ session: any; toolViews: AgentToolDefinitionView[]; serviceTiers: AgentServiceTierState }> {
  await ensureSessionFile(agent.path);
  await discardBootstrapOnlySession(agent.path);
  const [modelRuntime, defaultModel] = await Promise.all([
    createPiModelRuntime(),
    resolveNewWorkspaceAgentModel(),
  ]);
  const [agentsFiles, skillResources] = await Promise.all([
    loadWorkspaceAgentsFiles(agent.workspaceId),
    loadWorkspaceSkills(agent.workspaceId),
  ]);
  const appendSystemPrompt: string[] = [];
  await options.events?.emit("agent_system_prompt_prepare", { workspaceId: agent.workspaceId, lines: appendSystemPrompt });
  const sessionSettings = { compaction: { enabled: true, keepRecentTokens: compactionKeepRecentTokens } };
  if (defaultModel) Object.assign(sessionSettings, { defaultProvider: defaultModel.provider, defaultModel: defaultModel.id });
  const sessionManager = SessionManager.open(agent.path, dirname(agent.path), workspaceRoot);
  const serviceTiers = new AgentServiceTierState(sessionManager);
  const customTools = createWorkspaceAgentTools(agent.workspaceId, { events: options.events });
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir: dirname(agent.path),
    modelRuntime: modelRuntimeWithServiceTiers(modelRuntime, serviceTiers),
    model: initial.model,
    thinkingLevel: initial.thinkingLevel,
    resourceLoader: createAtelierResourceLoader(agentsFiles, appendSystemPrompt, skillResources),
    customTools,
    tools: workspaceAgentToolNames(),
    sessionManager,
    settingsManager: SettingsManager.inMemory(sessionSettings),
  });
  const provider = session.model?.provider;
  if (provider && initial.serviceTier && supportsFastMode(provider)) await serviceTiers.set(provider, initial.serviceTier);
  return {
    session,
    serviceTiers,
    toolViews: customTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
  };
}

async function ensureSessionFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", { flag: "a" });
}
