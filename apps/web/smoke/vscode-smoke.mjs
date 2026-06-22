import { chromium } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
const cwd = new URL('../../..', import.meta.url).pathname;
const namespace = `pw-vscode-${Date.now().toString(16)}`;
const port = Number(process.env.SMOKE_PORT ?? 3173);
const server = spawn('bun', ['run', 'apps/web/src/server/main.ts'], {
  cwd,
  env: { ...process.env, PORT: String(port), HOST: 'localhost', ATELIER_NAMESPACE: namespace },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (data) => process.stdout.write(`[server] ${data}`));
server.stderr.on('data', (data) => process.stderr.write(`[server err] ${data}`));

async function cleanup() {
  server.kill('SIGTERM');
  await delay(500);
  const listed = await execFileAsync('docker', ['ps', '-a', '--filter', 'label=com.atelier.type=workspace', '--filter', `label=com.atelier.namespace=${namespace}`, '--format', '{{.Names}}']).catch(() => ({ stdout: '' }));
  for (const name of listed.stdout.trim().split(/\n+/).filter(Boolean)) await execFileAsync('docker', ['rm', '-f', name]).catch(() => undefined);
}

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error('web server did not start');
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const consoleMessages = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /New workspace/ }).click();
  await page.waitForURL(/\/workspaces\//, { timeout: 10_000 });
  await page.getByRole('button', { name: 'VS Code', exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'VS Code', exact: true }).click();
  const frame = page.locator('iframe.vscode-frame');
  await frame.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const iframe = document.querySelector('iframe.vscode-frame');
    return iframe?.src?.includes('/workspaces/') && iframe.src.includes('/apps/vscode');
  }, null, { timeout: 10_000 });
  const src = await frame.getAttribute('src');
  const response = await fetch(src);
  const text = await response.text();
  if (!response.ok || !/Visual Studio Code|latest version of the Visual Studio Code Server|workbench/i.test(text)) throw new Error(`unexpected VS Code proxy response ${response.status}: ${text.slice(0, 200)}`);
  await delay(15_000);
  const cspFailures = consoleMessages.filter((message) => message.includes('Content Security Policy') || message.includes('vscode-remote-resource') && message.includes('Failed to fetch'));
  if (cspFailures.length > 0) throw new Error(`VS Code resource loading failed:\n${cspFailures.join('\n')}`);
  console.log(`playwright smoke passed: ${src}`);
} finally {
  await browser?.close();
  await cleanup();
}
