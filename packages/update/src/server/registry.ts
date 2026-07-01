import { type ReleaseChannel } from "./channels.ts";
import { repository } from "./constants.ts";

export interface ImageMetadata { digest: string; revision?: string; platformDigest?: string; selfUpdateCompatibility?: string }

interface RegistryAuth { realm: string; service?: string; scope?: string }

export function parseWwwAuthenticate(header: string): RegistryAuth | undefined {
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return undefined;
  const out: RegistryAuth = { realm: "" };
  for (const part of match[1].matchAll(/(\w+)="([^"]*)"/g)) {
    if (part[1] === "realm") out.realm = part[2];
    if (part[1] === "service") out.service = part[2];
    if (part[1] === "scope") out.scope = part[2];
  }
  return out.realm ? out : undefined;
}

async function authFetch(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const response = await fetcher(url, init);
  if (response.status !== 401) return response;
  const auth = parseWwwAuthenticate(response.headers.get("www-authenticate") ?? "");
  if (!auth) return response;
  const tokenUrl = new URL(auth.realm);
  if (auth.service) tokenUrl.searchParams.set("service", auth.service);
  if (auth.scope) tokenUrl.searchParams.set("scope", auth.scope);
  const tokenResponse = await fetcher(tokenUrl, { headers: { accept: "application/json" } });
  if (!tokenResponse.ok) throw new Error(`registry token request failed: ${tokenResponse.status}`);
  const tokenJson = await tokenResponse.json() as { token?: string; access_token?: string };
  const token = tokenJson.token ?? tokenJson.access_token;
  if (!token) throw new Error("registry token response did not include a token");
  return await fetcher(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` } });
}

function currentArch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

export function selectManifestFromIndex(index: { manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }> }, platform = { os: "linux", architecture: currentArch() }): string {
  const manifest = index.manifests?.find((candidate) => candidate.platform?.os === platform.os && candidate.platform?.architecture === platform.architecture);
  if (!manifest) throw new Error(`no ${platform.os}/${platform.architecture} manifest found`);
  return manifest.digest;
}

export async function fetchChannelImageMetadata(channel: ReleaseChannel, fetcher: typeof fetch = fetch): Promise<ImageMetadata> {
  const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${channel}`;
  const accept = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", ");
  let response = await authFetch(manifestUrl, { headers: { accept } }, fetcher);
  if (!response.ok) throw new Error(`registry manifest request failed: ${response.status}`);
  const rootDigest = response.headers.get("docker-content-digest") ?? "";
  let manifest = await response.json() as { mediaType?: string; manifests?: unknown[]; config?: { digest: string; mediaType?: string } };
  let platformDigest: string | undefined;
  if (manifest.manifests) {
    platformDigest = selectManifestFromIndex(manifest as { manifests?: Array<{ digest: string; platform?: { os?: string; architecture?: string } }> });
    response = await authFetch(`https://ghcr.io/v2/${repository}/manifests/${platformDigest}`, { headers: { accept } }, fetcher);
    if (!response.ok) throw new Error(`registry platform manifest request failed: ${response.status}`);
    manifest = await response.json() as { config?: { digest: string; mediaType?: string } };
  }
  if (!manifest.config?.digest) throw new Error("registry manifest did not include config digest");
  const configResponse = await authFetch(`https://ghcr.io/v2/${repository}/blobs/${manifest.config.digest}`, { headers: { accept: "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json" } }, fetcher);
  if (!configResponse.ok) throw new Error(`registry config request failed: ${configResponse.status}`);
  const labels = (await configResponse.json() as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
  return {
    digest: platformDigest ?? rootDigest,
    platformDigest,
    revision: labels["org.opencontainers.image.revision"],
    selfUpdateCompatibility: labels["com.atelier.self-update-compatibility"],
  };
}
