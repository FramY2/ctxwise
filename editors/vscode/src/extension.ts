/// <reference path="./vscode.d.ts" />
import * as vscode from "vscode";
import {
  analyzeWorkspaceContext,
  formatStatusBarText,
  formatStatusBarTooltip,
} from "./analyzer.js";

let statusBarItem: vscode.StatusBarItem | undefined;
let sharedTerminal: vscode.Terminal | undefined;
let sharedTerminalRoot: string | undefined;

function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getActiveWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.fsPath) {
    const normDoc = normalizeFsPath(activeUri.fsPath);
    let bestFolder: vscode.WorkspaceFolder | undefined;
    let bestLen = -1;
    for (const folder of folders) {
      const normFolder = normalizeFsPath(folder.uri.fsPath);
      if (
        (normDoc === normFolder || normDoc.startsWith(`${normFolder}/`)) &&
        normFolder.length > bestLen
      ) {
        bestFolder = folder;
        bestLen = normFolder.length;
      }
    }
    if (bestFolder) {
      return bestFolder.uri.fsPath;
    }
  }
  return folders[0]?.uri.fsPath;
}

function runCtxwiseCliInTerminal(subcommandArgs: string): void {
  const root = getActiveWorkspaceRoot();
  if (
    !sharedTerminal ||
    sharedTerminal.exitStatus !== undefined ||
    sharedTerminalRoot !== root
  ) {
    if (sharedTerminal && sharedTerminal.exitStatus === undefined) {
      sharedTerminal.dispose();
    }
    sharedTerminal = vscode.window.createTerminal(
      root ? { name: "CtxWise", cwd: root } : "CtxWise",
    );
    sharedTerminalRoot = root;
  }
  sharedTerminal.show(true);
  sharedTerminal.sendText(`npx @framy2/ctxwise ${subcommandArgs}`, true);
}

export function refreshStatusBar(): void {
  if (!statusBarItem) {
    return;
  }
  const root = getActiveWorkspaceRoot();
  if (!root) {
    statusBarItem.hide();
    return;
  }

  const summary = analyzeWorkspaceContext(root);
  statusBarItem.text = formatStatusBarText(summary);

  const md = new vscode.MarkdownString(formatStatusBarTooltip(summary), true);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  statusBarItem.tooltip = md;

  if (summary.secretCount > 0 || summary.grade === "F") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground",
    );
  } else if (summary.grade === "D" || summary.grade === "C") {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }

  statusBarItem.show();
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "ctxwise.runFullAudit";
  context.subscriptions.push(statusBarItem);

  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/{CLAUDE.md,AGENTS.md,AGENTS.override.md,.cursorrules,.mcp.json,.codex/config.toml,.claude/settings.json}",
  );
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(() => refreshStatusBar()),
    watcher.onDidChange(() => refreshStatusBar()),
    watcher.onDidDelete(() => refreshStatusBar()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBar()),
  );

  if (typeof vscode.window.onDidCloseTerminal === "function") {
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((closed) => {
        if (closed === sharedTerminal) {
          sharedTerminal = undefined;
          sharedTerminalRoot = undefined;
        }
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("ctxwise.runFullAudit", () => {
      runCtxwiseCliInTerminal("agents");
    }),
    vscode.commands.registerCommand("ctxwise.scanSecrets", () => {
      runCtxwiseCliInTerminal("shield --fail-on-risk");
    }),
    vscode.commands.registerCommand("ctxwise.inspectMcpTax", () => {
      runCtxwiseCliInTerminal("mcp-xray --probe-stdio");
    }),
    vscode.commands.registerCommand("ctxwise.refreshStatus", () => {
      refreshStatusBar();
    }),
  );

  refreshStatusBar();
}

export function deactivate(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
    statusBarItem = undefined;
  }
  if (sharedTerminal) {
    sharedTerminal.dispose();
    sharedTerminal = undefined;
    sharedTerminalRoot = undefined;
  }
}
