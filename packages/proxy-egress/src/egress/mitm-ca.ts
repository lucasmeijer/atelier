import { existsSync } from "node:fs";
import net from "node:net";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireFileLock, atelierDataPath, getAtelierRuntimeContext, type AtelierRuntimeContext } from "@atelier/core";

export type MitmCa = { dir: string; certPath: string; keyPath: string; leafDir: string };
type LeafCertificate = { certPath: string; keyPath: string; renewAt: number };

const leafCertificateRenewalWindowMs = 24 * 60 * 60 * 1000;
const leafCertificateLifetimeDays = 7;

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
    await chmod(keyPath, 0o600);
    await chmod(certPath, 0o644);
  }
  return { dir, certPath, keyPath, leafDir };
}

export async function ensureLeafCertificate(ca: MitmCa, hostname: string): Promise<LeafCertificate> {
  const safeName = hostname.toLowerCase().replace(/[^a-z0-9_.-]/g, "_");
  const certPath = join(ca.leafDir, `${safeName}.pem`);
  const keyPath = join(ca.leafDir, `${safeName}-key.pem`);
  const release = await acquireFileLock(join(ca.leafDir, `${safeName}.lock`), "certificate");
  let tmp = "";
  try {
    if (existsSync(certPath) && existsSync(keyPath)) {
      const renewAt = await certificateRenewalTime(certPath);
      if (Date.now() < renewAt) return { certPath, keyPath, renewAt };
    }

    tmp = await mkdtemp(join(ca.leafDir, ".atelier-leaf-"));
    const csr = join(tmp, "leaf.csr");
    const ext = join(tmp, "leaf.ext");
    const temporaryCertPath = join(tmp, "leaf.pem");
    const temporaryKeyPath = join(tmp, "leaf-key.pem");
    const subjectAltName = net.isIP(hostname) ? `IP:${hostname}` : `DNS:${hostname}`;
    await writeFile(ext, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${subjectAltName}\n`);
    await runOpenSsl(["req", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${hostname}`, "-keyout", temporaryKeyPath, "-out", csr]);
    await runOpenSsl(["x509", "-req", "-in", csr, "-CA", ca.certPath, "-CAkey", ca.keyPath, "-CAcreateserial", "-days", String(leafCertificateLifetimeDays), "-sha256", "-extfile", ext, "-out", temporaryCertPath]);
    await chmod(temporaryKeyPath, 0o600);
    await rename(temporaryKeyPath, keyPath);
    await rename(temporaryCertPath, certPath);
    return { certPath, keyPath, renewAt: await certificateRenewalTime(certPath) };
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    await release();
  }
}

async function certificateRenewalTime(certPath: string): Promise<number> {
  const output = await runOpenSsl(["x509", "-enddate", "-noout", "-in", certPath]);
  const prefix = "notAfter=";
  if (!output.startsWith(prefix)) throw new Error(`unexpected openssl certificate end date: ${output}`);
  const expiresAt = Date.parse(output.slice(prefix.length));
  if (!Number.isFinite(expiresAt)) throw new Error(`invalid openssl certificate end date: ${output}`);
  return expiresAt - leafCertificateRenewalWindowMs;
}

function runOpenSsl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += String(chunk));
    child.stderr.on("data", (chunk) => stderr += String(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`openssl failed (${code}): ${stderr.trim()}`)));
  });
}
