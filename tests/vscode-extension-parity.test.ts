import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeWorkspaceContext,
  listClaudeRuleFiles,
  parseMcpServersFromJson,
  WATCHED_RELATIVE_FILES,
  WATCHER_GLOB,
} from "../editors/vscode/src/analyzer.js";

const vscodeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "editors",
  "vscode",
);

const tempDirs: string[] = [];

function makeTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxwise-vscode-parity-"));
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

describe("ctxwise-vscode analyzer parity (v1.3.0)", () => {
  it("watches .cursor/mcp.json, .vscode/mcp.json, and .claude/rules/**/*.md", () => {
    expect(WATCHED_RELATIVE_FILES).toContain(".cursor/mcp.json");
    expect(WATCHED_RELATIVE_FILES).toContain(".vscode/mcp.json");
    expect(WATCHER_GLOB).toContain(".cursor/mcp.json");
    expect(WATCHER_GLOB).toContain(".vscode/mcp.json");
    expect(WATCHER_GLOB).toContain(".claude/rules/**/*.md");
    expect(WATCHER_GLOB.startsWith("**/{")).toBe(true);
  });

  it('parses both "mcpServers" and VS Code "servers" (JSONC) MCP configs', () => {
    expect(
      parseMcpServersFromJson(
        JSON.stringify({
          servers: { fetch: { type: "stdio" }, off: { disabled: true } },
        }),
      ),
    ).toEqual(["fetch"]);
    expect(
      parseMcpServersFromJson(
        '{\n  // comment\n  "servers": {\n    "docs": { "type": "http", "url": "https://x.dev/mcp" },\n  },\n}',
      ),
    ).toEqual(["docs"]);
    expect(
      parseMcpServersFromJson(JSON.stringify({ mcpServers: { a: {} } })),
    ).toEqual(["a"]);
    expect(parseMcpServersFromJson("{ broken")).toEqual([]);
  });

  it("aggregates MCP servers across .mcp.json, .cursor/mcp.json, .vscode/mcp.json and counts .claude/rules tokens and secrets", () => {
    const ws = makeTempWorkspace();
    mkdirSync(join(ws, ".cursor"), { recursive: true });
    mkdirSync(join(ws, ".vscode"), { recursive: true });
    mkdirSync(join(ws, ".claude", "rules", "nested"), { recursive: true });
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({ mcpServers: { github: { command: "npx" } } }),
      "utf8",
    );
    writeFileSync(
      join(ws, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { linear: { command: "npx" }, github: { command: "npx" } },
      }),
      "utf8",
    );
    writeFileSync(
      join(ws, ".vscode", "mcp.json"),
      '{\n  // VS Code\n  "servers": { "fetch": { "type": "stdio", "command": "uvx" } },\n}',
      "utf8",
    );
    writeFileSync(
      join(ws, ".claude", "rules", "style.md"),
      "# Style\n".repeat(40),
      "utf8",
    );
    writeFileSync(
      join(ws, ".claude", "rules", "nested", "leak.md"),
      "Use key sk-ant-api03-REALKEYabcdefghijklmnop12345\n",
      "utf8",
    );
    writeFileSync(join(ws, ".claude", "rules", "ignore.txt"), "x", "utf8");

    expect(listClaudeRuleFiles(ws)).toEqual([
      ".claude/rules/nested/leak.md",
      ".claude/rules/style.md",
    ]);

    const summary = analyzeWorkspaceContext(ws);
    expect(summary.mcpServerNames).toEqual(["fetch", "github", "linear"]);
    expect(summary.mcpServerCount).toBe(3);
    expect(summary.estimatedMcpTokens).toBe(3 * 1200);
    const paths = summary.files.map((f) => f.relativePath);
    expect(paths).toEqual(
      expect.arrayContaining([
        ".mcp.json",
        ".cursor/mcp.json",
        ".vscode/mcp.json",
        ".claude/rules/style.md",
        ".claude/rules/nested/leak.md",
      ]),
    );
    const styleBytes = Buffer.byteLength("# Style\n".repeat(40), "utf8");
    expect(summary.instructionTokens).toBeGreaterThanOrEqual(
      Math.ceil(styleBytes / 4),
    );
    expect(summary.secretCount).toBe(1);
    expect(summary.grade).toBe("F");
    expect(listClaudeRuleFiles(makeTempWorkspace())).toEqual([]);
  });

  it("is ready for vsce / ovsx packaging (version, icon, LICENSE, .vscodeignore)", () => {
    const pkg = JSON.parse(
      readFileSync(join(vscodeDir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg["version"]).toBe("1.3.0");
    expect(pkg["icon"]).toBe("icon.png");
    expect(pkg["license"]).toBe("Apache-2.0");
    expect(pkg["repository"]).toBeTruthy();
    expect(existsSync(join(vscodeDir, "LICENSE"))).toBe(true);

    const icon = readFileSync(join(vscodeDir, "icon.png"));
    expect(icon.subarray(1, 4).toString("ascii")).toBe("PNG");
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(128);

    const ignore = readFileSync(join(vscodeDir, ".vscodeignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    for (const pattern of [
      "src/**",
      "test/**",
      "**/*.ts",
      "tsconfig*.json",
      ".vitest*",
    ]) {
      expect(ignore).toContain(pattern);
    }
    for (const shipped of [
      "dist",
      "package.json",
      "README.md",
      "LICENSE",
      "icon.png",
    ]) {
      expect(ignore.some((l) => l.startsWith(shipped))).toBe(false);
    }
  });
});

describe("docs/index.html v1.3.0 Browser Shield & Auto-Fix parity", () => {
  const repoRoot = join(vscodeDir, "..", "..");
  const htmlPath = join(repoRoot, "docs", "index.html");

  async function loadWebSandbox() {
    const html = readFileSync(htmlPath, "utf8");
    const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
    if (!scriptMatch?.[1]) {
      throw new Error("Expected inline <script> in docs/index.html");
    }
    const { runInNewContext } = await import("node:vm");
    const makeEl = () => ({
      value: "",
      checked: false,
      textContent: "",
      innerHTML: "",
      className: "",
      style: { display: "" },
      classList: {
        add() {},
        remove() {},
        contains() {
          return false;
        },
      },
    });
    const els = {
      guidanceInput: makeEl(),
      mcpInput: makeEl(),
      perTurnTokens: makeEl(),
      sessionTokens: makeEl(),
      mcpStats: makeEl(),
      securityStats: makeEl(),
      codexCapLabel: makeEl(),
      codexCapBar: makeEl(),
      gradeBadge: makeEl(),
      costTableBody: makeEl(),
      shieldAlert: makeEl(),
      autoFixPanel: makeEl(),
      autoFixSummary: makeEl(),
      autoFixReadOnly: makeEl(),
      autoFixMcpCode: makeEl(),
      autoFixWireTapCode: makeEl(),
    };
    const sandbox: Record<string, unknown> = {
      Math,
      JSON,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
      Set,
      Map,
      Error,
      TextEncoder,
      setTimeout,
      document: {
        getElementById(id: string) {
          return Object.prototype.hasOwnProperty.call(els, id)
            ? els[id as keyof typeof els]
            : null;
        },
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        },
      },
      navigator: {
        clipboard: {
          async writeText() {},
        },
      },
    };
    runInNewContext(scriptMatch[1], sandbox);
    return { html, els, sandbox };
  }

  it("displays v1.3.0, mcp-diet v0.2.0, and agent-wire-tap v0.3.0 versions", () => {
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("v1.3.0");
    expect(html).toContain("v0.2.0");
    expect(html).toContain("v0.3.0");
    expect(html).not.toContain("v1.2.0");
  });

  it("flags unpinned npx -y runners and inline auth headers while allowing pinned packages and env refs", async () => {
    const { els, sandbox } = await loadWebSandbox();
    const recalc = sandbox["recalculate"] as () => void;

    els.mcpInput.value = JSON.stringify({
      mcpServers: {
        unpinned: { command: "npx", args: ["-y", "@scope/unpinned-tool"] },
      },
    });
    recalc();
    expect(els.securityStats.textContent).toBe("1 issue(s)");
    expect(els.shieldAlert.innerHTML).toContain("Unpinned");

    els.mcpInput.value = JSON.stringify({
      mcpServers: {
        pinned: { command: "npx", args: ["-y", "@scope/pinned-tool@1.2.3"] },
        safeHttp: {
          url: "https://api.example.com/mcp",
          headers: {
            Authorization: "Bearer ${API_TOKEN}",
            "x-api-key": "$SERVICE_KEY",
          },
        },
      },
    });
    recalc();
    expect(els.securityStats.textContent).toBe("0 findings");

    els.mcpInput.value = JSON.stringify({
      mcpServers: {
        leakedHttp: {
          url: "https://api.example.com/mcp",
          headers: {
            Authorization: "Bearer live_token_value_123456",
            "x-api-key": "secret_key_value_123456",
          },
        },
      },
    });
    recalc();
    expect(els.securityStats.textContent).toBe("2 issue(s)");
  });

  it("renders interactive Auto-Fix mcp-diet wrapper (.mcp.json & .vscode/mcp.json), wire-tap command, and escapes untrusted HTML", async () => {
    const { els, sandbox } = await loadWebSandbox();
    const recalc = sandbox["recalculate"] as () => void;

    els.mcpInput.value = JSON.stringify({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
        },
        wrapped: {
          command: "npx",
          args: ["-y", "@framy2/mcp-diet@0.2.0", "--", "node", "srv.js"],
        },
        remote: { url: "https://mcp.example.com/sse" },
      },
    });
    recalc();

    expect(els.autoFixPanel.style.display).toBe("block");
    expect(els.autoFixWireTapCode.textContent).toBe(
      'npx @framy2/agent-wire-tap@0.3.0 --passthrough --assert-tools-sorted --assert-cache-breakpoint-covers-tools --assert-no-prefix-divergence -- claude -p "healthcheck"',
    );
    const wrapped = JSON.parse(els.autoFixMcpCode.textContent) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    };
    expect(wrapped.mcpServers["github"]?.command).toBe("npx");
    expect(wrapped.mcpServers["github"]?.args).toEqual([
      "-y",
      "@framy2/mcp-diet@0.2.0",
      "--max-desc",
      "160",
      "--max-result-kb",
      "512",
      "--redact-secrets",
      "--",
      "npx",
      "-y",
      "@modelcontextprotocol/server-github@2025.4.8",
    ]);
    expect(wrapped.mcpServers["github"]?.env).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}",
    });
    expect(wrapped.mcpServers["wrapped"]?.args).toEqual([
      "-y",
      "@framy2/mcp-diet@0.2.0",
      "--",
      "node",
      "srv.js",
    ]);
    expect(wrapped.mcpServers["remote"]).toEqual({
      url: "https://mcp.example.com/sse",
    });

    // Preserves .vscode/mcp.json "servers" key and adds --read-only when toggled
    els.autoFixReadOnly.checked = true;
    els.mcpInput.value = JSON.stringify({
      servers: {
        fs: {
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem@2026.1.14",
            ".",
          ],
        },
      },
    });
    recalc();
    const vsWrapped = JSON.parse(els.autoFixMcpCode.textContent) as {
      servers: Record<string, { args: string[] }>;
    };
    expect(vsWrapped.servers["fs"]?.args).toContain("--read-only");

    // XSS prevention: malicious HTML payloads in server names/args are HTML-escaped
    els.mcpInput.value = JSON.stringify({
      mcpServers: {
        '<img src=x onerror="alert(1)">': {
          command: "npx",
          args: ["-y", "@evil/unpinned-pkg"],
        },
        "<svg onload=alert(1)>": {
          url: "https://mcp.example.com/sse",
          headers: { Authorization: "Bearer live_token_value_123456" },
        },
      },
    });
    recalc();
    expect(els.securityStats.textContent).toBe("2 issue(s)");
    expect(els.shieldAlert.innerHTML).not.toContain("<img");
    expect(els.shieldAlert.innerHTML).not.toContain("<svg");
    expect(els.shieldAlert.innerHTML).toContain("&lt;img");
    expect(els.shieldAlert.innerHTML).toContain("&lt;svg");
    expect(els.autoFixMcpCode.innerHTML).toBe("");
    expect(els.autoFixMcpCode.textContent).toContain(
      '<img src=x onerror=\\"alert(1)\\">',
    );
  });
});
