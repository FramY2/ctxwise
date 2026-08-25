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

describe("CtxWise CLI", () => {
  it("reports the version published in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(
        fileURLToPath(new URL("../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { version: string };
    const { stdout } = await execFileAsync(process.execPath, [
      tsx,
      cli,
      "--version",
    ]);

    expect(stdout.trim()).toBe(packageJson.version);
  });

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
});
