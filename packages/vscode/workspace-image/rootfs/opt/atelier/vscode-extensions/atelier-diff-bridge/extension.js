const vscode = require("vscode");

function gitUri(uri, ref) {
  return uri.with({
    scheme: "git",
    query: JSON.stringify({ path: uri.fsPath, ref }),
  });
}

function lineNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function openDiffSnippet(payload) {
  const file = String(payload.file);
  const startLine = lineNumber(payload.startLine, 1);
  const endLine = lineNumber(payload.endLine, startLine);
  const uri = vscode.Uri.file(file);
  const original = gitUri(uri, payload.ref ? String(payload.ref) : "~");
  const title = payload.title ? String(payload.title) : `${file.split("/").pop()} (Working Tree)`;
  const selection = new vscode.Range(startLine - 1, 0, Math.max(startLine - 1, endLine - 1), 0);

  await vscode.commands.executeCommand("workbench.view.scm");
  await vscode.commands.executeCommand("vscode.diff", original, uri, title, { preview: false, preserveFocus: false, selection });
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.selection = new vscode.Selection(selection.start, selection.end);
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("atelier.openDiffSnippet", openDiffSnippet));
}

function deactivate() {}

module.exports = { activate, deactivate };
