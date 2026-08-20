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
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ATELIER_NAMESPACE: namespace },
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
  const createdResponse = await fetch(`http://localhost:${port}/workspaces`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ source: { type: 'empty' }, title: 'VS Code smoke test' }),
  });
  if (!createdResponse.ok) throw new Error(`workspace creation failed: ${createdResponse.status} ${await createdResponse.text()}`);
  const created = await createdResponse.json();
  const workspaceId = created.workspace.id;
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await fetch(`http://localhost:${port}/workspaces/${workspaceId}`, { headers: { accept: 'application/json' } });
    const body = await response.json();
    if (body.workspace.phase === 'ready') break;
    if (body.workspace.phase === 'failed') throw new Error(`workspace provisioning failed: ${JSON.stringify(body)}`);
    if (attempt === 299) throw new Error('workspace provisioning did not finish');
    await delay(250);
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleMessages = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto(`http://localhost:${port}/workspaces/${workspaceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Open Work pane', exact: true }).click();
  await page.locator('summary[aria-label="Open Work view"]').click();
  await page.getByRole('button', { name: 'Open VS Code', exact: true }).click();
  await page.getByRole('tab', { name: /^VS Code/ }).click();
  const frame = page.locator('iframe.vscode-frame');
  await frame.waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => {
    const iframe = document.querySelector('iframe.vscode-frame');
    return iframe?.src?.includes('/workspaces/') && iframe.src.includes('/apps/vscode');
  }, null, { timeout: 10_000 });
  const src = await frame.evaluate((element) => element.src);
  const response = await fetch(src);
  const text = await response.text();
  if (!response.ok || !/Visual Studio Code|latest version of the Visual Studio Code Server|workbench/i.test(text)) throw new Error(`unexpected VS Code proxy response ${response.status}: ${text.slice(0, 200)}`);
  const vscode = page.frameLocator('iframe.vscode-frame');
  await vscode.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 60_000 });
  await vscode.locator('body').evaluate(async () => {
    await globalThis.__atelierVSCodeCommands.executeCommand('workbench.action.focusActiveEditorGroup');
  });
  const cspFailures = consoleMessages.filter((message) => message.includes('Content Security Policy') || message.includes('vscode-remote-resource') && message.includes('Failed to fetch'));
  if (cspFailures.length > 0) throw new Error(`VS Code resource loading failed:\n${cspFailures.join('\n')}`);
  console.log(`playwright smoke passed: ${src}`);
} finally {
  await browser?.close();
  await cleanup();
}
