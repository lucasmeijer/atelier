import { shellQuote } from "@atelier/core";
import type { ResolvedDockerImagePreload } from "./carrier.ts";
import type { DockerRuntimeConnection } from "./runtime-connection.ts";
import { publishSharedImage } from "./shared-build.ts";

/** Publish on the creator side; only digest references and aliases cross into
 * initialization. The workspace pulls directly from the installation registry. */
export async function prepareSharedImagePreload(connection: DockerRuntimeConnection, preload: ResolvedDockerImagePreload): Promise<string[]> {
  if (!connection.buildServices) throw new Error("shared preloads require a registry connection");
  const initScripts: string[] = [];
  for (const image of preload.images) {
    if (image.sourceRef.includes("@")) {
      // Republishing a platform-filtered index can change its digest. Preserve
      // explicitly requested upstream digest identities rather than forging tags.
      initScripts.push([`docker pull ${shellQuote(image.sourceRef)}`, ...image.aliases.map(alias => `docker tag ${shellQuote(image.sourceRef)} ${shellQuote(alias)}`)].join(" &&\n"));
      continue;
    }
    const published = await publishSharedImage(connection, image.imageId);
    const reference = `${connection.buildServices.registryAddress}/${published}`;
    const aliases = [...new Set([image.sourceRef, ...image.aliases])].filter(alias => !/^sha256:[a-f0-9]{64}$/.test(alias));
    const tags = aliases.length ? aliases : [`atelier-preloaded:${published.split("sha256:")[1]}`];
    initScripts.push([
      `docker pull ${shellQuote(reference)}`,
      ...tags.map(alias => `docker tag ${shellQuote(reference)} ${shellQuote(alias)}`),
      `docker image rm ${shellQuote(reference)}`,
    ].join(" &&\n"));
  }
  return initScripts;
}
