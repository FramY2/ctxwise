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

describe("ctxwise-vscode analyzer parity (v1.2.0)", () => {
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
    expect(pkg["version"]).toBe("1.2.0");
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
