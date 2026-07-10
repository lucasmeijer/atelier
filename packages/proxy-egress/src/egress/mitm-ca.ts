import { existsSync } from "node:fs";
import net from "node:net";
import { chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { atelierDataPath, getAtelierRuntimeContext, type AtelierRuntimeContext } from "@atelier/core";

export type MitmCa = { dir: string; certPath: string; keyPath: string; leafDir: string };

const leafCertificateEnsures = new Map<string, Promise<{ certPath: string; keyPath: string }>>();

export async function ensureMitmCa(context?: AtelierRuntimeContext): Promise<MitmCa> {
  const runtime = context ?? getAtelierRuntimeContext();
  const dir = process.env.ATELIER_MITM_CA_DIR || atelierDataPath(runtime, "proxy-ca");
  const certPath = join(dir, "atelier-mitm-ca.pem");
  const keyPath = join(dir, "atelier-mitm-ca-key.pem");
  const leafDir = join(dir, "leaf");
  await mkdir(leafDir, { recursive: true, mode: 0o700 });
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    await runOpenSsl([
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "1825", "-nodes",
      "-subj", "/CN=Atelier Local Workspace MITM CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", keyPath, "-out", certPath,
    ]);
    await chmod(keyPath, 0o600).catch(() => {});
    await chmod(certPath, 0o644).catch(() => {});
  }
  return { dir, certPath, keyPath, leafDir };
}

export async function ensureLeafCertificate(ca: MitmCa, hostname: string): Promise<{ certPath: string; keyPath: string }> {
  const safeName = hostname.toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  const cacheKey = `${ca.leafDir}:${safeName}`;
  let promise = leafCertificateEnsures.get(cacheKey);
  if (!promise) {
    promise = ensureLeafCertificateUncached(ca, hostname, safeName).finally(() => leafCertificateEnsures.delete(cacheKey));
    leafCertificateEnsures.set(cacheKey, promise);
  }
  return await promise;
}

async function ensureLeafCertificateUncached(ca: MitmCa, hostname: string, safeName: string): Promise<{ certPath: string; keyPath: string }> {
  const certPath = join(ca.leafDir, `${safeName}.pem`);
  const keyPath = join(ca.leafDir, `${safeName}-key.pem`);
  if (existsSync(certPath) && existsSync(keyPath)) return { certPath, keyPath };

  const release = await acquireDirLock(join(ca.leafDir, `${safeName}.lock`));
  let tmp = "";
  try {
    if (existsSync(certPath) && existsSync(keyPath)) return { certPath, keyPath };
    tmp = await mkdtemp(join(tmpdir(), "atelier-leaf-"));
    const csr = join(tmp, "leaf.csr");
    const ext = join(tmp, "leaf.ext");
    const subjectAltName = net.isIP(hostname) ? `IP:${hostname}` : `DNS:${hostname}`;
    await writeFile(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${subjectAltName}\n`);
    await runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`, "-keyout", keyPath, "-out", csr]);
    await runOpenSsl(["x509", "-req", "-in", csr, "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAcreateserial", "-days", "30", "-sha256", "-extfile", ext, "-out", certPath]);
    await chmod(keyPath, 0o600).catch(() => {});
    return { certPath, keyPath };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    await release();
  }
}

async function acquireDirLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      return async () => { await rmdir(lockDir).catch(() => {}); };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw new Error(`timed out waiting for certificate lock: ${lockDir}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function runOpenSsl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`openssl failed (${code}): ${stderr.trim()}`)));
  });
}
