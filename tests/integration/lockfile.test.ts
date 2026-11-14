import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCapabilityLock,
  redactSensitiveContent,
  sanitizeJsonConfigForHash,
} from "../../src/lockfile.js";
import { cleanupDirectories } from "../support/temp.js";

const created: string[] = [];
afterEach(() => cleanupDirectories(created));

describe("buildCapabilityLock", () => {
  it("hashes a redacted context surface without serializing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-lock-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-terra"\napi_key = "super-secret"\n[mcp_servers.test.env]\nTOKEN = "hidden"\n',
    );

    const lock = await buildCapabilityLock({
      codexHome,
      projectRoot: root,
      now: new Date("2026-08-08T12:00:00Z"),
    });
    const serialized = JSON.stringify(lock);
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };

    expect(lock.generator.name).toBe("ctxwise");
    expect(lock.generator.version).toBe(packageJson.version);
    expect(lock.entries).toHaveLength(1);
    expect(lock.entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain(root.replaceAll("\\", "/"));
  });

  it("redacts every value inside an MCP env section but preserves normal config", () => {
    const result = redactSensitiveContent(
      'model = "gpt-5.6-terra"\n[mcp_servers.demo.env]\nREGION = "eu"\n',
    );

    expect(result.redacted).toBe(true);
    expect(result.content).toContain('model = "gpt-5.6-terra"');
    expect(result.content).not.toContain('REGION = "eu"');
  });

  it("returns an empty manifest for absent context surfaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-empty-lock-"));
    created.push(root);

    const lock = await buildCapabilityLock({
      codexHome: join(root, "missing-home"),
      projectRoot: join(root, "missing-project"),
    });

    expect(lock.entries).toEqual([]);
  });

  it("locks only the active root-to-working-directory guidance chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-lock-guidance-chain-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    const workingDirectory = join(projectRoot, "services", "payments");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
      mkdir(join(projectRoot, "unrelated"), { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "AGENTS.md"), "root guidance\n");
    await writeFile(
      join(projectRoot, "services", "AGENTS.override.md"),
      "service guidance\n",
    );
    await writeFile(
      join(projectRoot, "unrelated", "AGENTS.md"),
      "unrelated guidance\n",
    );

    const input = { codexHome, projectRoot, workingDirectory };
    const lock = await buildCapabilityLock(input);
    const guidanceEntries = lock.entries.filter(
      (entry) =>
        entry.scope === "project" &&
        entry.path.toLowerCase().includes("agents"),
    );

    expect(guidanceEntries.map((entry) => entry.path)).toEqual([
      "AGENTS.md",
      "services/AGENTS.override.md",
    ]);
  });

  it("excludes multi-agent surfaces by default when includeMultiAgent is false/omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-lock-codex-default-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(root, ".claude", "rules"), { recursive: true }),
      mkdir(join(root, ".cursor"), { recursive: true }),
      mkdir(join(root, ".vscode"), { recursive: true }),
    ]);
    await writeFile(join(root, "AGENTS.md"), "codex rules\n");
    await writeFile(join(root, "CLAUDE.md"), "claude rules\n");
    await writeFile(
      join(root, ".claude", "settings.json"),
      '{"disableAllHooks":false}\n',
    );
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{}}\n');
    await writeFile(join(root, ".cursorrules"), "cursor rules\n");

    const lock = await buildCapabilityLock({ codexHome, projectRoot: root });
    expect("includeMultiAgent" in lock).toBe(false);
    expect(lock.entries.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
  });

  it("discovers and hashes all multi-agent surfaces when includeMultiAgent is true without leaking secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-lock-multi-agent-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(root, ".claude", "rules", "security"), { recursive: true }),
      mkdir(join(root, ".cursor"), { recursive: true }),
      mkdir(join(root, ".vscode"), { recursive: true }),
    ]);

    await writeFile(
      join(codexHome, "config.toml"),
      'project_doc_fallback_filenames = ["CLAUDE.md"]\n',
    );
    await writeFile(join(root, "CLAUDE.md"), "Project CLAUDE guidance\n");
    await writeFile(
      join(root, ".claude", "CLAUDE.md"),
      "Nested Claude guidance\n",
    );
    await writeFile(
      join(root, ".claude", "rules", "security", "mcp.md"),
      "Never bypass hooks.\n",
    );
    await writeFile(join(root, ".cursorrules"), "Cursor project rules\n");
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        disableAllHooks: false,
        permissions: { deny: ["Edit(.claude/**)", "Write(.claude/**)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "^mcp__",
              hooks: [{ type: "command", command: "exit 2" }],
            },
          ],
        },
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-supersecret1234567890" },
      }),
    );
    await writeFile(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({ apiKey: "local-secret-token" }),
    );
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github@1.0.0"],
            env: { GITHUB_TOKEN: "ghp_123456789012345678901234567890" },
          },
          remote: {
            type: "http",
            url: "https://mcp.example.com",
            headers: { Authorization: "Bearer super-secret-jwt-value" },
          },
        },
      }),
    );
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["server.js"] },
        },
      }),
    );
    await writeFile(
      join(root, ".vscode", "mcp.json"),
      `{\n  // VS Code MCP servers\n  "servers": {\n    "api": {\n      "url": "https://api.example.dev/mcp",\n      "headers": { "X-API-Key": "vscode-secret-key-9999" },\n    },\n  },\n}\n`,
    );

    const lock1 = await buildCapabilityLock({
      codexHome,
      projectRoot: root,
      includeMultiAgent: true,
    });
    const serialized = JSON.stringify(lock1);

    expect(lock1.includeMultiAgent).toBe(true);
    expect(
      lock1.entries
        .filter((entry) => entry.scope === "codex-home")
        .map((entry) => entry.path),
    ).toEqual(["config.toml"]);
    expect(
      lock1.entries
        .filter((entry) => entry.scope === "project")
        .map((entry) => entry.path),
    ).toEqual([
      ".claude/CLAUDE.md",
      ".claude/rules/security/mcp.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".cursor/mcp.json",
      ".cursorrules",
      ".mcp.json",
      ".vscode/mcp.json",
      "CLAUDE.md",
    ]);
    expect(serialized).not.toContain("sk-ant-api03-supersecret1234567890");
    expect(serialized).not.toContain("local-secret-token");
    expect(serialized).not.toContain("ghp_123456789012345678901234567890");
    expect(serialized).not.toContain("super-secret-jwt-value");
    expect(serialized).not.toContain("vscode-secret-key-9999");

    const settingsEntry1 = lock1.entries.find(
      (e) => e.path === ".claude/settings.json",
    );
    const mcpEntry1 = lock1.entries.find((e) => e.path === ".mcp.json");
    expect(settingsEntry1?.redacted).toBe(true);
    expect(mcpEntry1?.redacted).toBe(true);

    // Rotating secrets preserves hash, while toggling disableAllHooks changes hash
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github@1.0.0"],
            env: { GITHUB_TOKEN: "ghp_rotated9876543210987654321098765" },
          },
          remote: {
            type: "http",
            url: "https://mcp.example.com",
            headers: { Authorization: "Bearer rotated-secret-jwt-value" },
          },
        },
      }),
    );
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        disableAllHooks: true,
        permissions: { deny: ["Edit(.claude/**)", "Write(.claude/**)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "^mcp__",
              hooks: [{ type: "command", command: "exit 2" }],
            },
          ],
        },
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-rotated1234567890" },
      }),
    );

    const lock2 = await buildCapabilityLock({
      codexHome,
      projectRoot: root,
      includeMultiAgent: true,
    });
    const settingsEntry2 = lock2.entries.find(
      (e) => e.path === ".claude/settings.json",
    );
    const mcpEntry2 = lock2.entries.find((e) => e.path === ".mcp.json");

    expect(mcpEntry2?.sha256).toBe(mcpEntry1?.sha256);
    expect(settingsEntry2?.sha256).not.toBe(settingsEntry1?.sha256);
  });
});

describe("sanitizeJsonConfigForHash", () => {
  it("redacts secrets/tokens/headers to <redacted> while preserving hooks, disableAllHooks, permissions, and server definitions", () => {
    const raw = JSON.stringify({
      disableAllHooks: false,
      apiKeyHelper: "/usr/local/bin/get-key.sh",
      maxOutputTokens: 4096,
      permissions: { deny: ["Edit(.claude/**)", "Write(.claude/**)"] },
      hooks: { PreToolUse: [{ matcher: "^mcp__", hooks: [] }] },
      mcpServers: {
        demo: {
          command: "npx",
          args: [
            "-y",
            "@scope/mcp@1.0.0",
            "--header",
            "Authorization: Bearer inline-token-12345",
          ],
          env: { MY_VAR: "secret-env", PORT: 3000 },
          headers: {
            Authorization: "Bearer header-secret",
            "X-API-Key": "secret-api-key",
            "X-Custom": "Bearer custom-bearer",
            Accept: "application/json",
            key: "secret-header-key",
          },
        },
      },
      pinToken: 1234,
    });

    const result = sanitizeJsonConfigForHash(raw);
    expect(result.redacted).toBe(true);
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.disableAllHooks).toBe(false);
    expect(parsed.apiKeyHelper).toBe("/usr/local/bin/get-key.sh");
    expect(parsed.maxOutputTokens).toBe(4096);
    expect(parsed.pinToken).toBe("<redacted>");
    expect(parsed.permissions).toEqual({
      deny: ["Edit(.claude/**)", "Write(.claude/**)"],
    });
    expect(parsed.hooks).toEqual({
      PreToolUse: [{ matcher: "^mcp__", hooks: [] }],
    });

    expect(result.content).not.toContain("inline-token-12345");
    expect(result.content).not.toContain("secret-env");
    expect(result.content).not.toContain("header-secret");
    expect(result.content).not.toContain("secret-api-key");
    expect(result.content).not.toContain("custom-bearer");
    expect(result.content).not.toContain("secret-header-key");
    expect(result.content).toContain('"Accept": "application/json"');
    expect(result.content).toContain('"command": "npx"');
    expect(result.content).toContain('"<redacted>"');
  });

  it("handles malformed JSON fail-safely without leaking secrets", () => {
    const raw = '{ "Authorization": "Bearer secret-jwt-token-xyz", "broken": ';
    const result = sanitizeJsonConfigForHash(raw);
    expect(result.redacted).toBe(true);
    expect(result.content).not.toContain("secret-jwt-token-xyz");
    expect(result.content).toContain("<redacted>");
  });
});
