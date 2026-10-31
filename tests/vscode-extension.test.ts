import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeWorkspaceContext,
  computeContextGrade,
  countSecretsInContent,
  formatCompactTokens,
  formatStatusBarText,
  formatStatusBarTooltip,
  parseMcpServersFromJson,
  parseMcpServersFromToml,
} from "../editors/vscode/src/analyzer.js";

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxwise-vscode-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ctxwise-vscode status-bar analyzer", () => {
  it("calculates tokens, Grade A, status bar pill, and rich Markdown tooltip on a clean workspace", () => {
    const ws = makeTempWorkspace();
    writeFileSync(
      join(ws, "CLAUDE.md"),
      "# Project Rules\n".repeat(25),
      "utf8",
    );
    writeFileSync(join(ws, "AGENTS.md"), "# Agent Rules\n".repeat(25), "utf8");
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          disabledServer: {
            command: "node",
            args: ["server.js"],
            disabled: true,
          },
        },
      }),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.mcpServerCount).toBe(1);
    expect(summary.mcpServerNames).toEqual(["github"]);
    expect(summary.secretCount).toBe(0);
    expect(summary.grade).toBe("A");
    expect(summary.totalEstimatedTokens).toBe(summary.instructionTokens + 1200);

    const pill = formatStatusBarText(summary);
    expect(pill).toContain("$(shield) CtxWise:");
    expect(pill).toContain("Grade A");
    expect(pill).toContain("0 secrets");

    const tooltip = formatStatusBarTooltip(summary);
    expect(tooltip).toContain("CtxWise Context Firewall — Grade **A**");
    expect(tooltip).toContain("`github`");
    expect(tooltip).toContain("command:ctxwise.runFullAudit");
    expect(tooltip).toContain("command:ctxwise.scanSecrets");
    expect(tooltip).toContain("command:ctxwise.inspectMcpTax");
  });

  it("detects real leaked secrets while ignoring placeholders and downgrades to Grade F", () => {
    const ws = makeTempWorkspace();
    const fakeAnthropicKey = [
      "sk-ant-api03",
      "RealSecretTokenValue9988776655",
    ].join("-");
    writeFileSync(
      join(ws, "CLAUDE.md"),
      [
        "Example placeholder: sk-ant-api03-example_placeholder_key_000000",
        "Example URI: postgres://user:password@localhost:5432/db",
        `Live leaked key: ${fakeAnthropicKey}`,
        "Live DB URI: postgres://prod_admin:R9vK2mP8xQ4wL7nJ@db.internal:5432/app",
      ].join("\n"),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.secretCount).toBe(2);
    expect(summary.grade).toBe("F");

    const pill = formatStatusBarText(summary);
    expect(pill).toBe("$(warning) CtxWise: 64 tok · Grade F · 2 secrets");
  });

  it("flags Codex 32 KiB byte cap overflow and misplaced mcpServers in .claude/settings.json", () => {
    const ws = makeTempWorkspace();
    writeFileSync(join(ws, "AGENTS.md"), "A".repeat(20_000), "utf8");
    writeFileSync(join(ws, "AGENTS.override.md"), "B".repeat(15_000), "utf8");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { bad: { command: "node" } } }),
      "utf8",
    );

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.codexInstructionBytes).toBe(35_000);
    expect(summary.codexByteCapPercent).toBeGreaterThan(100);
    expect(summary.misplacedMcpInSettings).toBe(true);
    expect(summary.grade).toBe("F");

    const tooltip = formatStatusBarTooltip(summary);
    expect(tooltip).toContain("Claude Settings Hygiene");
    expect(tooltip).toContain("#105885");
  });

  it("handles empty workspaces, TOML MCP servers, and malformed JSON gracefully", () => {
    const ws = makeTempWorkspace();
    const emptySummary = analyzeWorkspaceContext(ws);
    expect(emptySummary.files).toEqual([]);
    expect(emptySummary.grade).toBe("A");
    expect(formatStatusBarText(emptySummary)).toBe(
      "$(shield) CtxWise: 0 tok · Grade A · 0 secrets",
    );

    expect(parseMcpServersFromJson("{broken json")).toEqual([]);
    expect(parseMcpServersFromJson("null")).toEqual([]);
    expect(
      parseMcpServersFromJson(
        JSON.stringify({
          mcpServers: {
            active: { command: "npx" },
            disabledFlag: { command: "npx", disabled: true },
            enabledFalse: { command: "npx", enabled: false },
          },
        }),
      ),
    ).toEqual(["active"]);
    expect(
      parseMcpServersFromToml(`
[mcp_servers.postgres] # inline comment
command = "npx"
[mcp_servers."github.enterprise"]
command = "npx"
[mcp_servers.playwright]
command = "npx"
[mcp_servers.playwright.env]
NODE_ENV = "production"
[mcp_servers.pruned_server]
command = "npx"
enabled = false
[mcp_servers.disabled_server]
command = "npx"
disabled = true
`),
    ).toEqual(["postgres", "github.enterprise", "playwright"]);

    expect(formatCompactTokens(450)).toBe("450");
    expect(formatCompactTokens(2_400)).toBe("2.4k");
    expect(formatCompactTokens(12_000)).toBe("12k");
    expect(countSecretsInContent("clean text")).toBe(0);
    expect(
      computeContextGrade({
        totalEstimatedTokens: 4_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: false,
      }),
    ).toBe("B");
    expect(
      computeContextGrade({
        totalEstimatedTokens: 9_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: false,
      }),
    ).toBe("C");
    expect(
      computeContextGrade({
        totalEstimatedTokens: 1_500,
        codexByteCapPercent: 20,
        secretCount: 0,
        misplacedMcpInSettings: true,
      }),
    ).toBe("D");
  });
});

describe("ctxwise-vscode extension host lifecycle & multi-root support", () => {
  it("activates status bar, switches multi-root workspace on active editor change, and recovers from closed terminals", async () => {
    const wsA = makeTempWorkspace();
    const wsB = makeTempWorkspace();
    writeFileSync(join(wsA, "CLAUDE.md"), "Clean root A", "utf8");
    const leakedKey = ["sk-ant-api03", "RealSecretTokenValue9988776655"].join(
      "-",
    );
    writeFileSync(join(wsB, "CLAUDE.md"), `Leaked in B: ${leakedKey}`, "utf8");

    const registeredCommands = new Map<
      string,
      (...args: unknown[]) => unknown
    >();
    const createdTerminals: Array<{
      name: string;
      cwd?: string | undefined;
      exitStatus?: { code: number | undefined } | undefined;
      sent: string[];
      disposed: boolean;
      show: () => void;
      sendText: (t: string) => void;
      dispose: () => void;
    }> = [];
    let editorChangeListener: (() => void) | undefined;
    let closeTerminalListener: ((t: unknown) => void) | undefined;
    let lastStatusBarItem:
      | {
          text: string;
          tooltip?: unknown;
          backgroundColor?: { id: string } | undefined;
          command?: string | undefined;
          shown: boolean;
          hidden: boolean;
          disposed: boolean;
        }
      | undefined;

    const mockVscode = {
      StatusBarAlignment: { Left: 1, Right: 2 },
      ThemeColor: class {
        readonly id: string;
        constructor(id: string) {
          this.id = id;
        }
      },
      MarkdownString: class {
        value: string;
        isTrusted?: boolean;
        supportThemeIcons?: boolean;
        constructor(value = "", supportThemeIcons = false) {
          this.value = value;
          this.supportThemeIcons = supportThemeIcons;
        }
      },
      workspace: {
        workspaceFolders: [
          { uri: { fsPath: wsA }, name: "rootA", index: 0 },
          { uri: { fsPath: wsB }, name: "rootB", index: 1 },
        ],
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => undefined }),
          onDidChange: () => ({ dispose: () => undefined }),
          onDidDelete: () => ({ dispose: () => undefined }),
          dispose: () => undefined,
        }),
      },
      window: {
        activeTextEditor: undefined as
          { document: { uri: { fsPath: string } } } | undefined,
        createStatusBarItem: () => {
          const item = {
            alignment: 2,
            text: "",
            tooltip: undefined as unknown,
            backgroundColor: undefined as { id: string } | undefined,
            command: undefined as string | undefined,
            shown: false,
            hidden: false,
            disposed: false,
            show() {
              this.shown = true;
            },
            hide() {
              this.hidden = true;
            },
            dispose() {
              this.disposed = true;
            },
          };
          lastStatusBarItem = item;
          return item;
        },
        createTerminal: (opts?: string | { name?: string; cwd?: string }) => {
          const term = {
            name: typeof opts === "string" ? opts : (opts?.name ?? "CtxWise"),
            ...(typeof opts === "object" && opts?.cwd ? { cwd: opts.cwd } : {}),
            exitStatus: undefined as { code: number | undefined } | undefined,
            sent: [] as string[],
            disposed: false,
            show() {},
            sendText(t: string) {
              this.sent.push(t);
            },
            dispose() {
              this.disposed = true;
            },
          };
          createdTerminals.push(term);
          return term;
        },
        onDidChangeActiveTextEditor: (cb: () => void) => {
          editorChangeListener = cb;
          return { dispose: () => undefined };
        },
        onDidCloseTerminal: (cb: (t: unknown) => void) => {
          closeTerminalListener = cb;
          return { dispose: () => undefined };
        },
      },
      commands: {
        registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => {
          registeredCommands.set(id, cb);
          return { dispose: () => undefined };
        },
      },
    };

    const { vi } = await import("vitest");
    vi.doMock("vscode", () => mockVscode);
    const ext = await import("../editors/vscode/src/extension.js");

    const subscriptions: Array<{ dispose(): unknown }> = [];
    ext.activate({ subscriptions });

    expect(lastStatusBarItem?.shown).toBe(true);
    expect(lastStatusBarItem?.text).toContain("Grade A");
    expect(lastStatusBarItem?.backgroundColor).toBeUndefined();

    // Switch active editor to rootB (which contains a leaked secret)
    mockVscode.window.activeTextEditor = {
      document: { uri: { fsPath: join(wsB, "src", "index.ts") } },
    };
    editorChangeListener?.();
    expect(ext.getActiveWorkspaceRoot()).toBe(wsB);
    expect(lastStatusBarItem?.text).toContain("Grade F");
    expect(lastStatusBarItem?.text).toContain("1 secret");
    expect(lastStatusBarItem?.backgroundColor?.id).toBe(
      "statusBarItem.errorBackground",
    );

    // Run audit command in terminal (should open in wsB)
    registeredCommands.get("ctxwise.runFullAudit")?.();
    expect(createdTerminals.length).toBe(1);
    expect(createdTerminals[0]?.cwd).toBe(wsB);
    expect(createdTerminals[0]?.sent).toEqual(["npx @framy2/ctxwise agents"]);

    // Simulate user closing the terminal -> next command must create a fresh terminal
    if (createdTerminals[0]) {
      createdTerminals[0].exitStatus = { code: 0 };
      closeTerminalListener?.(createdTerminals[0]);
    }
    registeredCommands.get("ctxwise.scanSecrets")?.();
    expect(createdTerminals.length).toBe(2);
    expect(createdTerminals[1]?.sent).toEqual([
      "npx @framy2/ctxwise shield --fail-on-risk",
    ]);

    ext.deactivate();
    expect(lastStatusBarItem?.disposed).toBe(true);
    expect(createdTerminals[1]?.disposed).toBe(true);
    vi.doUnmock("vscode");
  });
});

describe("docs/index.html interactive calculator runtime verification", () => {
  it("executes presets, TOML fallback, .claude/settings.json #105885 detection, and secret/placeholder rules in a browser-like VM", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { runInNewContext } = await import("node:vm");
    const html = readFileSync(
      fileURLToPath(new URL("../docs/index.html", import.meta.url)),
      "utf8",
    );
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    expect(scriptMatch?.[1]).toBeTruthy();

    const elements = new Map<
      string,
      {
        value: string;
        textContent: string;
        innerHTML: string;
        className: string;
        style: Record<string, string>;
        classList: { remove: () => void; add: () => void };
      }
    >();
    const getEl = (id: string) => {
      let el = elements.get(id);
      if (!el) {
        el = {
          value: "",
          textContent: "",
          innerHTML: "",
          className: "",
          style: {},
          classList: { remove: () => undefined, add: () => undefined },
        };
        elements.set(id, el);
      }
      return el;
    };

    const sandbox: Record<string, unknown> = {
      TextEncoder,
      document: {
        getElementById: (id: string) => getEl(id),
        querySelectorAll: () => [],
        querySelector: () => getEl("presetBtn"),
      },
      navigator: {
        clipboard: { writeText: () => Promise.resolve() },
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
    };

    runInNewContext(scriptMatch?.[1] ?? "", sandbox);

    // 1. Default heavy preset loaded on startup
    expect(getEl("mcpStats").textContent).toBe("3 srv · 62 tools");
    expect(getEl("gradeBadge").textContent).toBe("Grade D");
    expect(getEl("costTableBody").innerHTML).toContain("Claude Opus 4.7");
    expect(getEl("costTableBody").innerHTML).toContain("GPT-6.1-Sol");

    // 2. Load leak preset
    const loadPreset = sandbox["loadPreset"] as (name: string) => void;
    loadPreset("leak");
    expect(getEl("gradeBadge").textContent).toBe("Grade F");
    expect(getEl("shieldAlert").innerHTML).toContain("105885");

    // 3. Load lean preset
    loadPreset("lean");
    expect(getEl("gradeBadge").textContent).toBe("Grade A");
    expect(getEl("securityStats").textContent).toBe("0 findings");

    // 4. Test realistic .claude/settings.json with env/disableClaudeAiConnectors (no permissions/$comment)
    const recalculate = sandbox["recalculate"] as () => void;
    getEl("guidanceInput").value =
      "postgres://user:password@localhost:5432/db\n";
    getEl("mcpInput").value = JSON.stringify({
      env: { FOO: "1" },
      disableClaudeAiConnectors: true,
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    });
    recalculate();
    expect(getEl("securityStats").textContent).toBe("1 issue(s)");
    expect(getEl("gradeBadge").textContent).toBe("Grade D");

    // 5. Test .codex/config.toml input with disabled server
    getEl("guidanceInput").value = "# Clean AGENTS.md";
    getEl("mcpInput").value = `
[mcp_servers.github] # active
command = "npx"
[mcp_servers.pruned]
command = "npx"
enabled = false
`;
    recalculate();
    expect(getEl("mcpStats").textContent).toBe("1 srv · 26 tools");
  });
});
