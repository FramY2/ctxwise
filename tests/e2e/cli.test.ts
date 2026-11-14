import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupDirectories } from "../support/temp.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const fakeCodex = fileURLToPath(
  new URL("../fixtures/fake-codex.mjs", import.meta.url),
);
const tsx = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url),
);
const created: string[] = [];

afterEach(() => cleanupDirectories(created));

// Each test spawns one or more `tsx` CLI processes; cold Windows runs and
// loaded CI runners regularly exceed Vitest's 5s default per test.
describe("CtxWise CLI", { timeout: 20_000 }, () => {
  it("reports the version published in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    const { stdout } = await execFileAsync(
      process.execPath,
      [tsx, cli, "--version"],
      { timeout: 10_000 },
    );

    expect(stdout.trim()).toBe(packageJson.version);
  }, 10_000);

  it("runs Codex and appends an honest subscription receipt", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "run",
        "--codex-command",
        process.execPath,
        "--codex-prefix-arg",
        fakeCodex,
        "--model",
        "gpt-5.6-sol",
        "--receipt",
        "--prompt-xray",
        "test prompt",
      ],
      { timeout: 10_000 },
    );

    expect(stdout).toContain("Fake Codex answer");
    expect(stdout).toContain("CtxWise receipt");
    expect(stdout).toContain("10,000 input");
    expect(stdout).toContain("prompt ≈ 1,003");
    expect(stdout).toContain("37% used");
    expect(stdout).not.toContain("$");
  });

  it("shows API equivalent only when explicitly requested", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "run",
        "--codex-command",
        process.execPath,
        "--codex-prefix-arg",
        fakeCodex,
        "--model",
        "gpt-5.6-sol",
        "--receipt",
        "--api-equivalent",
        "test prompt",
      ],
      { timeout: 10_000 },
    );

    expect(stdout).toContain("comparison only; not charged");
  });

  it("reports an unavailable Codex executable exactly once in doctor", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "doctor",
        "--codex-command",
        "ctxwise-command-that-does-not-exist",
      ],
      { timeout: 10_000 },
    );

    expect(stdout.match(/Codex: unavailable/g)).toHaveLength(1);
    expect(stdout).toContain("Price catalog");
  });

  it("discovers the Git root when audit runs from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-audit-cli-root-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    const workingDirectory = join(projectRoot, "services", "payments");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "AGENTS.md"), "root guidance\n");
    await writeFile(
      join(projectRoot, "services", "AGENTS.override.md"),
      "service guidance\n",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [tsx, cli, "audit", "--codex-home", codexHome, "--json"],
      { cwd: workingDirectory, timeout: 10_000 },
    );
    const report = JSON.parse(stdout) as {
      sources: Array<{ kind: string; path: string }>;
    };

    expect(
      report.sources
        .filter((source) => source.kind === "agents-guidance")
        .map((source) => source.path),
    ).toEqual(["project/AGENTS.md", "project/services/AGENTS.override.md"]);
  });

  it("honors configured project root markers during nested audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-audit-cli-marker-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    const workingDirectory = join(projectRoot, "nested");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(workingDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(codexHome, "config.toml"),
      'project_root_markers = [".ctxwise-root"]\n',
    );
    await writeFile(join(projectRoot, ".ctxwise-root"), "");
    await writeFile(join(projectRoot, "AGENTS.md"), "custom root guidance\n");

    const { stdout } = await execFileAsync(
      process.execPath,
      [tsx, cli, "audit", "--codex-home", codexHome, "--json"],
      { cwd: workingDirectory, timeout: 10_000 },
    );
    const report = JSON.parse(stdout) as {
      sources: Array<{ kind: string; path: string }>;
    };

    expect(
      report.sources
        .filter((source) => source.kind === "agents-guidance")
        .map((source) => source.path),
    ).toEqual(["project/AGENTS.md"]);
  });

  it("shows an immediate local context snapshot without a model call", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-snapshot-cli-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "AGENTS.md"), "project guidance\n");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "snapshot",
        "--codex-home",
        codexHome,
        "--project",
        projectRoot,
      ],
      { cwd: projectRoot, timeout: 10_000 },
    );

    expect(stdout).toContain("CtxWise snapshot");
    expect(stdout).toContain("known startup tokens (estimated)");
    expect(stdout).toContain("project/AGENTS.md");
  });

  it("enforces a local context budget through command flags or a strict YAML policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-budget-cli-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    const policyPath = join(root, "ctxwise.budget.yaml");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
    ]);
    await writeFile(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    await writeFile(join(projectRoot, "AGENTS.md"), "project guidance\n");
    await writeFile(
      policyPath,
      "version: 1\nmaxKnownTokens: 100\nunknown: warn\n",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "budget",
        "--codex-home",
        codexHome,
        "--project",
        projectRoot,
        "--policy",
        policyPath,
        "--json",
        "--fail-on-exceed",
      ],
      { cwd: projectRoot, timeout: 10_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      status: "within-budget",
      unknownSurfaces: { configProfileSources: 1 },
    });

    await expect(
      execFileAsync(
        process.execPath,
        [
          tsx,
          cli,
          "budget",
          "--codex-home",
          codexHome,
          "--project",
          projectRoot,
          "--max-known-tokens",
          "1",
          "--fail-on-exceed",
        ],
        { cwd: projectRoot, timeout: 10_000 },
      ),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("auto-loads ctxwise.budget.yaml and budgets Claude Code-only repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-budget-auto-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "CLAUDE.md"), "x".repeat(4_000));
    await writeFile(
      join(projectRoot, "ctxwise.budget.yaml"),
      "version: 1\nmaxKnownTokens: 500\nunknown: warn\n",
    );
    const args = [
      tsx,
      cli,
      "budget",
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--json",
    ];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: "" };

    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: projectRoot,
      env,
      timeout: 10_000,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      status: "over-budget",
      estimatedKnownStartupTokens: 1_000,
      limits: { maxKnownTokens: 500 },
      agent: "all",
      policy: "ctxwise.budget.yaml",
      agentBreakdown: {
        agents: { codex: 0, claude: 1_000, cursor: 0 },
        budgetedAgent: "claude",
      },
    });
    await expect(
      execFileAsync(process.execPath, [...args, "--fail-on-exceed"], {
        cwd: projectRoot,
        env,
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 2 });

    const { stdout: codexOnly } = await execFileAsync(
      process.execPath,
      [...args, "--agent", "codex", "--fail-on-exceed"],
      { cwd: projectRoot, env, timeout: 10_000 },
    );
    expect(JSON.parse(codexOnly)).toMatchObject({
      status: "within-budget",
      agent: "codex",
    });
  }, 20_000);

  it("fails agents --fail-on-divergence when CLAUDE.md and AGENTS.md drift apart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-agents-diverge-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const claudeHome = join(root, ".claude-home");
    const projectRoot = join(root, "repo");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(claudeHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "AGENTS.md"), "Use pnpm.\n");
    await writeFile(join(projectRoot, "CLAUDE.md"), "Use pnpm.\n");
    const args = [
      tsx,
      cli,
      "agents",
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--project",
      projectRoot,
      "--fail-on-divergence",
    ];

    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: projectRoot,
      timeout: 10_000,
    });
    expect(stdout).toContain("parity: synced");

    await writeFile(join(projectRoot, "CLAUDE.md"), "Use npm.\n");
    await expect(
      execFileAsync(process.execPath, args, {
        cwd: projectRoot,
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 1 });
  }, 20_000);

  it("blocks an unreadable audit configuration instead of approving the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-budget-error-"));
    created.push(root);
    await writeFile(join(root, "config.toml"), "invalid = [");
    const args = [
      tsx,
      cli,
      "budget",
      "--codex-home",
      root,
      "--project",
      root,
      "--max-known-tokens",
      "100000",
      "--json",
    ];
    const { stdout } = await execFileAsync(process.execPath, args);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "unknown",
      summary: { blocking: 1 },
    });
    await expect(
      execFileAsync(process.execPath, [...args, "--fail-on-exceed"]),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("compares two capability locks and can fail a CI check on drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-drift-cli-"));
    created.push(root);
    const baselinePath = join(root, "baseline.json");
    const currentPath = join(root, "current.json");
    const makeLock = (sha256: string) => ({
      schemaVersion: 1,
      generator: { name: "ctxwise", version: "0.1.0" },
      generatedAt: "2026-08-09T10:00:00.000Z",
      provenance: "local-files",
      entries: [
        {
          scope: "project",
          path: "AGENTS.md",
          sha256,
          bytes: 100,
          redacted: false,
        },
      ],
    });
    await writeFile(baselinePath, JSON.stringify(makeLock("a".repeat(64))));
    await writeFile(currentPath, JSON.stringify(makeLock("b".repeat(64))));

    const { stdout } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "drift",
      baselinePath,
      "--current",
      currentPath,
      "--json",
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "drifted",
      summary: { changed: 1, total: 1 },
    });

    await expect(
      execFileAsync(process.execPath, [
        tsx,
        cli,
        "drift",
        baselinePath,
        "--current",
        currentPath,
        "--fail-on-drift",
      ]),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("runs codex-doctor, mcp-prune, and init --preset sveltekit-typescript from the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-new-cmds-cli-"));
    created.push(root);
    const codexHome = join(root, ".codex");
    const projectRoot = join(root, "repo");
    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
    ]);

    const { stdout: initOut } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "init",
      "--preset",
      "sveltekit-typescript",
      "--project",
      projectRoot,
      "--json",
    ]);
    expect(JSON.parse(initOut)).toMatchObject({
      preset: { name: "sveltekit" },
    });

    const nestedDir = join(projectRoot, "packages", "web");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "AGENTS.override.md"),
      "Web package override.\n",
      "utf8",
    );

    const { stdout: doctorOut } = await execFileAsync(
      process.execPath,
      [
        tsx,
        cli,
        "codex-doctor",
        "--codex-home",
        codexHome,
        "--cwd",
        nestedDir,
        "--json",
      ],
      { cwd: root, timeout: 10_000 },
    );
    expect(JSON.parse(doctorOut)).toMatchObject({
      status: "healthy",
      truncated: false,
      maxBytes: 32768,
      chain: [
        { path: "project/AGENTS.md" },
        { path: "project/packages/web/AGENTS.override.md" },
      ],
    });

    await writeFile(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo_server: { command: "npx", args: ["-y", "demo-mcp"] },
        },
      }),
      "utf8",
    );

    const { stdout: pruneOut } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "mcp-prune",
      "--project",
      projectRoot,
      "--disable",
      "demo_server",
      "--json",
    ]);
    expect(JSON.parse(pruneOut)).toMatchObject({
      mode: "prune",
      disabledServers: ["demo_server"],
    });

    const sarifOutPath = join(root, "ctxwise.sarif");
    await execFileAsync(process.execPath, [
      tsx,
      cli,
      "shield",
      "--project",
      projectRoot,
      "--sarif",
      sarifOutPath,
    ]);
    const sarifJson = JSON.parse(await readFile(sarifOutPath, "utf8")) as {
      version: string;
      runs: Array<{ tool: { driver: { name: string } } }>;
    };
    expect(sarifJson.version).toBe("2.1.0");
    expect(sarifJson.runs[0]?.tool.driver.name).toBe("CtxWise Shield");

    await mkdir(join(projectRoot, ".claude"), { recursive: true });
    await writeFile(
      join(projectRoot, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "^mcp__(?!github__)",
              hooks: [{ type: "command", command: "exit 2" }],
            },
          ],
        },
      }),
      "utf8",
    );

    await expect(
      execFileAsync(process.execPath, [
        tsx,
        cli,
        "shield",
        "--project",
        projectRoot,
        "--strict",
      ]),
    ).rejects.toMatchObject({ code: 2 });
  }, 20_000);

  it("locks multi-agent configs with --all-agents and enforces fail-closed drift policies with --policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-drift-policy-e2e-"));
    created.push(root);
    const codexHome = join(root, ".codex-home");
    const projectRoot = join(root, "repo");
    const lockPath = join(root, "out", "ctxwise.lock.json");
    const policyPath = join(projectRoot, "ctxwise.drift.yaml");

    await Promise.all([
      mkdir(codexHome, { recursive: true }),
      mkdir(join(projectRoot, ".git"), { recursive: true }),
      mkdir(join(projectRoot, ".claude", "rules"), { recursive: true }),
    ]);
    await writeFile(join(projectRoot, "AGENTS.md"), "Use pnpm.\n");
    await writeFile(join(projectRoot, "CLAUDE.md"), "Use pnpm.\n");
    await writeFile(
      join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({
        disableAllHooks: false,
        permissions: { deny: ["Edit(.claude/**)", "Write(.claude/**)"] },
        env: { ANTHROPIC_API_KEY: "sk-ant-api03-e2e-secret-1234567890" },
      }),
    );
    await writeFile(
      join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://mcp.example.com",
            headers: { Authorization: "Bearer e2e-live-token-12345" },
          },
        },
      }),
    );

    await execFileAsync(process.execPath, [
      tsx,
      cli,
      "lock",
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--all-agents",
      "--out",
      lockPath,
    ]);

    const lockText = await readFile(lockPath, "utf8");
    const parsedLock = JSON.parse(lockText) as {
      includeMultiAgent?: boolean;
      entries: Array<{ path: string }>;
    };
    expect(parsedLock.includeMultiAgent).toBe(true);
    expect(parsedLock.entries.map((e) => e.path)).toEqual([
      ".claude/settings.json",
      ".mcp.json",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(lockText).not.toContain("e2e-secret-1234567890");
    expect(lockText).not.toContain("e2e-live-token-12345");

    // Baseline vs live without --policy preserves backward-compatible JSON shape (no `policy` key)
    const { stdout: cleanRaw } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "drift",
      lockPath,
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--json",
      "--fail-on-drift",
    ]);
    const cleanReport = JSON.parse(cleanRaw) as Record<string, unknown>;
    expect(cleanReport.status).toBe("clean");
    expect("policy" in cleanReport).toBe(false);

    // Add a modular rule and edit CLAUDE.md
    await writeFile(
      join(projectRoot, ".claude", "rules", "style.md"),
      "Prefer concise diffs.\n",
    );
    await writeFile(join(projectRoot, "CLAUDE.md"), "Use pnpm cleanly.\n");

    await writeFile(
      policyPath,
      `version: 1
maxAdded: 2
maxChanged: 2
maxBytesDelta: 2048
rules:
  - id: deny-settings
    action: deny
    scope: project
    paths: [".claude/settings.json"]
    reason: "Settings are locked."
  - id: warn-claude
    action: warn
    scope: project
    paths: ["CLAUDE.md"]
    changes: ["changed"]
    reason: "Warn on CLAUDE.md edits."
  - id: allow-rules
    action: allow
    scope: project
    paths: [".claude/rules/**/*.md"]
    changes: ["added", "changed"]
    reason: "Allow modular rules."
`,
    );

    // Allowed + warned changes within thresholds pass even with --fail-on-drift!
    const { stdout: warnPolicyRaw } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "drift",
      lockPath,
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--policy",
      policyPath,
      "--json",
      "--fail-on-drift",
    ]);
    expect(JSON.parse(warnPolicyRaw)).toMatchObject({
      status: "drifted",
      policy: {
        path: "ctxwise.drift.yaml",
        status: "warn",
        blocking: false,
        summary: { allowed: 1, warned: 1, denied: 0, unmatched: 0 },
      },
    });

    // Human-readable output
    const { stdout: warnText } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "drift",
      lockPath,
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--policy",
      policyPath,
    ]);
    expect(warnText).toContain("policy: warn");
    expect(warnText).toContain("[ALLOW]");
    expect(warnText).toContain("[WARN]");

    // Now tamper with .claude/settings.json (auto-discovered via lock.includeMultiAgent=true without --all-agents!)
    await writeFile(
      join(projectRoot, ".claude", "settings.json"),
      JSON.stringify({ disableAllHooks: true }),
    );
    await expect(
      execFileAsync(process.execPath, [
        tsx,
        cli,
        "drift",
        lockPath,
        "--codex-home",
        codexHome,
        "--project",
        projectRoot,
        "--policy",
        policyPath,
        "--fail-on-drift",
      ]),
    ).rejects.toMatchObject({ code: 2 });

    // Also test --all-agents on a Codex-only baseline detects new multi-agent files
    const codexOnlyLockPath = join(root, "codex-only.lock.json");
    await execFileAsync(process.execPath, [
      tsx,
      cli,
      "lock",
      "--codex-home",
      codexHome,
      "--project",
      projectRoot,
      "--out",
      codexOnlyLockPath,
    ]);
    await expect(
      execFileAsync(process.execPath, [
        tsx,
        cli,
        "drift",
        codexOnlyLockPath,
        "--codex-home",
        codexHome,
        "--project",
        projectRoot,
        "--all-agents",
        "--fail-on-drift",
      ]),
    ).rejects.toMatchObject({ code: 2 });

    // Malformed policy YAML exits with code 1
    const badPolicyPath = join(root, "bad-policy.yaml");
    await writeFile(badPolicyPath, "version: 1\nunknownKey: true\nrules: []\n");
    await expect(
      execFileAsync(process.execPath, [
        tsx,
        cli,
        "drift",
        lockPath,
        "--codex-home",
        codexHome,
        "--project",
        projectRoot,
        "--policy",
        badPolicyPath,
      ]),
    ).rejects.toMatchObject({ code: 1 });
  }, 30_000);
});
