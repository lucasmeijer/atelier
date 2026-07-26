import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AtelierCoreError, getAtelierRuntimeContext } from "@atelier/core";

const keyBytes = 32;
const ivBytes = 12;

function projectSecretsKeyFile(dataDir = getAtelierRuntimeContext().atelierDataDir): string {
  return join(dataDir, "project-secrets.key");
}

async function readOrCreateMasterKey(file: string): Promise<Buffer> {
  try {
    const key = Buffer.from((await readFile(file, "utf8")).trim(), "base64url");
    if (key.byteLength !== keyBytes) throw new AtelierCoreError("invalid_project_secret_key", `project secrets key must be ${keyBytes} bytes`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(keyBytes);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
    return key;
  }
}

function aad(projectId: string, secretId: string): Buffer {
  return Buffer.from(`project-secret:${projectId}:${secretId}:v1`, "utf8");
}

export async function encryptProjectValue(projectId: string, secretId: string, plaintext: string, keyFile = projectSecretsKeyFile()): Promise<string> {
  const key = await readOrCreateMasterKey(keyFile);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(projectId, secretId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url")}`;
}

export async function decryptProjectValue(projectId: string, secretId: string, encryptedValue: string, keyFile = projectSecretsKeyFile()): Promise<string> {
  const [version, encodedIv, encodedPayload] = encryptedValue.split(":");
  if (version !== "v1" || !encodedIv || !encodedPayload) throw new AtelierCoreError("invalid_project_secret_ciphertext", `invalid project secret ciphertext: ${secretId}`);
  const payload = Buffer.from(encodedPayload, "base64url");
  if (payload.byteLength < 16) throw new AtelierCoreError("invalid_project_secret_ciphertext", `invalid project secret ciphertext: ${secretId}`);
  const decipher = createDecipheriv("aes-256-gcm", await readOrCreateMasterKey(keyFile), Buffer.from(encodedIv, "base64url"));
  decipher.setAAD(aad(projectId, secretId));
  decipher.setAuthTag(payload.subarray(-16));
  return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8");
}
