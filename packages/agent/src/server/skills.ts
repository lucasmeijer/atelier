import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { execWorkspaceCommand, workspaceRoot } from "@atelier/workspace";
import {
  createSyntheticSourceInfo,
  loadSkills,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";

interface WorkspaceSkillFile {
  path: string;
  content: string;
}

const skillRoots = [
  `${workspaceRoot}/.atelier/skills`,
  `${workspaceRoot}/.agents/skills`,
  `${workspaceRoot}/.pi/skills`,
] as const;

function skillRoot(path: string): (typeof skillRoots)[number] {
  const root = skillRoots.find((candidate) => path.startsWith(`${candidate}/`));
  if (!root) throw new Error(`skill is outside a supported root: ${path}`);
  return root;
}

function orderedSkillFiles(files: WorkspaceSkillFile[]): WorkspaceSkillFile[] {
  return [...files].sort((left, right) => {
    const rootOrder = skillRoots.indexOf(skillRoot(left.path)) - skillRoots.indexOf(skillRoot(right.path));
    return rootOrder || left.path.localeCompare(right.path);
  });
}

function workspacePath(snapshotRoot: string, path: string): string {
  const prefix = join(snapshotRoot, workspaceRoot.slice(1));
  if (!path.startsWith(`${prefix}/`)) throw new Error(`skill snapshot path is outside the workspace: ${path}`);
  return path.slice(snapshotRoot.length);
}

function workspaceDiagnostic(snapshotRoot: string, diagnostic: ResourceDiagnostic): ResourceDiagnostic {
  return {
    ...diagnostic,
    path: diagnostic.path ? workspacePath(snapshotRoot, diagnostic.path) : undefined,
    collision: diagnostic.collision ? {
      ...diagnostic.collision,
      winnerPath: workspacePath(snapshotRoot, diagnostic.collision.winnerPath),
      loserPath: workspacePath(snapshotRoot, diagnostic.collision.loserPath),
    } : undefined,
  };
}

/** Use Pi's skill parser and validation against files copied from a workspace container. */
export async function workspaceSkillsFromFiles(files: WorkspaceSkillFile[]): Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }> {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "atelier-skills-"));
  try {
    const paths: string[] = [];
    for (const file of orderedSkillFiles(files)) {
      const path = join(snapshotRoot, file.path.slice(1));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
      paths.push(path);
    }
    const result = loadSkills({
      cwd: join(snapshotRoot, workspaceRoot.slice(1)),
      agentDir: join(snapshotRoot, "agent"),
      skillPaths: paths,
      includeDefaults: false,
    });
    return {
      skills: result.skills.map((skill) => {
        const filePath = workspacePath(snapshotRoot, skill.filePath);
        const baseDir = posix.dirname(filePath);
        return {
          ...skill,
          filePath,
          baseDir,
          sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir }),
        };
      }),
      diagnostics: result.diagnostics.map((diagnostic) => workspaceDiagnostic(snapshotRoot, diagnostic)),
    };
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

/** Discover Agent Skills without assuming the Atelier server can mount the workspace filesystem. */
export async function loadWorkspaceSkills(workspaceId: string): Promise<{ skills: Skill[]; diagnostics: ResourceDiagnostic[] }> {
  const script = `set -eu
for root in ${skillRoots.map((root) => `'${root}'`).join(" ")}; do
  test -d "$root" || continue
  find -L "$root" -mindepth 2 -type f -name SKILL.md -not -path '*/node_modules/*' \
    -exec sh -c 'set -eu; for path do printf "%s\\0" "$path"; base64 "$path" | tr -d "\\n"; printf "\\0"; done' sh {} +
done`;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", script], { workdir: workspaceRoot });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not load workspace skills");
  const fields = result.stdout.split("\0");
  fields.pop();
  if (fields.length % 2 !== 0) throw new Error("invalid workspace skill discovery output");
  const files: WorkspaceSkillFile[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    files.push({ path: fields[index], content: Buffer.from(fields[index + 1], "base64").toString("utf8") });
  }
  return workspaceSkillsFromFiles(files);
}
