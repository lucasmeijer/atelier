import { fileURLToPath } from "node:url";
import { shellQuote } from "@atelier/core";
import type { ResolvedDockerImagePreload } from "./carrier.ts";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";
import { publishSharedImage } from "./shared-build.ts";

/** Publish on the creator side; only digest references and aliases cross into
 * initialization. The workspace pulls through its inherited registry socket. */
export async function prepareSharedImagePreload(connection: DockerRuntimeConnection, preload: ResolvedDockerImagePreload): Promise<{ containerFiles: { source: string; target: string }[]; initScripts: string[] }> {
  if (!connection.buildServices) throw new Error("shared preloads require a registry connection");
  const runner = "/.atelier/registry-relay.ts";
  const initScripts: string[] = [];
  for (const image of preload.images) {
    if (image.sourceRef.includes("@")) {
      // Republishing a platform-filtered index can change its digest. Preserve
      // explicitly requested upstream digest identities rather than forging tags.
      initScripts.push([`docker pull ${shellQuote(image.sourceRef)}`, ...image.aliases.map(alias => `docker tag ${shellQuote(image.sourceRef)} ${shellQuote(alias)}`)].join("\n"));
      continue;
    }
    const reference = await publishSharedImage(connection, image.imageId);
    const aliases = [...new Set([image.sourceRef, ...image.aliases])].filter(alias => !/^sha256:[a-f0-9]{64}$/.test(alias));
    initScripts.push(["bun", runner, connection.buildServices.registrySocket, reference, ...aliases].map(shellQuote).join(" "));
  }
  return { containerFiles: [{ source: fileURLToPath(new URL("./registry-relay.ts", import.meta.url)), target: runner }], initScripts };
}
