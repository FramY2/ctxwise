import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  renderCodexDoctorReport,
  runCodexDoctor,
} from "../../src/codex-doctor.js";
import { withTempDir } from "../support/temp.js";

describe("OpenAI Codex 32 KiB Doctor (codex-doctor)", () => {
  it("audits a healthy nested AGENTS.md and AGENTS.override.md hierarchy", async () => {
    await withTempDir("ctxwise-codex-doctor-ok-", async (root) => {
      const codexHome = join(root, ".codex");
      const projectRoot = join(root, "repo");
      const nestedCwd = join(projectRoot, "packages", "api");
      await mkdir(codexHome, { recursive: true });
      await mkdir(nestedCwd, { recursive: true });

      await writeFile(join(codexHome, "AGENTS.md"), "Global instructions.\n");
      await writeFile(join(projectRoot, "AGENTS.md"), "Root instructions.\n");
      await writeFile(
        join(nestedCwd, "AGENTS.override.md"),
        "API override instructions.\n",
      );
      await writeFile(
        join(nestedCwd, "AGENTS.md"),
        "Shadowed API instructions.\n",
      );

      const report = await runCodexDoctor({
        codexHome,
        projectRoot,
        workingDirectory: nestedCwd,
      });

      expect(report.status).toBe("healthy");
      expect(report.truncated).toBe(false);
      expect(report.maxBytes).toBe(32_768);
      expect(report.chain.map((c) => c.path)).toEqual([
        "codex-home/AGENTS.md",
        "project/AGENTS.md",
        "project/packages/api/AGENTS.override.md",
      ]);
      expect(report.chain[2]?.shadowedPaths).toEqual([
        "project/packages/api/AGENTS.md",
      ]);
      expect(report.findings.map((f) => f.code)).toContain("override-active");

      const rendered = renderCodexDoctorReport(report);
      expect(rendered).toContain("CtxWise codex-doctor · healthy");
      expect(rendered).toContain(
        "project/packages/api/AGENTS.override.md: 27/27 bytes",
      );
    });
  });

  it("warns when an empty AGENTS.override.md shadows AGENTS.md in a project directory", async () => {
    await withTempDir("ctxwise-codex-doctor-empty-", async (root) => {
      const codexHome = join(root, ".codex");
      const projectRoot = join(root, "repo");
      await mkdir(codexHome, { recursive: true });
      await mkdir(projectRoot, { recursive: true });

      await writeFile(join(codexHome, "AGENTS.override.md"), "   \n");
      await writeFile(join(codexHome, "AGENTS.md"), "Active global.\n");
      await writeFile(join(projectRoot, "AGENTS.override.md"), "\n\t  \n");
      await writeFile(
        join(projectRoot, "AGENTS.md"),
        "Important project rules that get shadowed!\n",
      );

      const report = await runCodexDoctor({
        codexHome,
        projectRoot,
      });

      expect(report.status).toBe("warning");
      expect(report.findings.map((f) => f.code)).toContain(
        "empty-global-override",
      );
      expect(report.findings.map((f) => f.code)).toContain(
        "empty-override-shadows-agents",
      );
      expect(report.recommendations.join(" ")).toContain(
        "Remove empty `AGENTS.override.md`",
      );
    });
  });

  it("detects 32 KiB / project_doc_max_bytes truncation across nested directories", async () => {
    await withTempDir("ctxwise-codex-doctor-trunc-", async (root) => {
      const codexHome = join(root, ".codex");
      const projectRoot = join(root, "repo");
      const serviceDir = join(projectRoot, "services", "billing");
      const leafDir = join(serviceDir, "worker");
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(projectRoot, ".codex"), { recursive: true });
      await mkdir(leafDir, { recursive: true });

      await writeFile(
        join(projectRoot, ".codex", "config.toml"),
        "project_doc_max_bytes = 100\n",
      );
      await writeFile(join(projectRoot, "AGENTS.md"), "A".repeat(60));
      await writeFile(join(serviceDir, "AGENTS.md"), "B".repeat(60));
      await writeFile(join(leafDir, "AGENTS.md"), "C".repeat(40));

      const report = await runCodexDoctor({
        codexHome,
        projectRoot,
        workingDirectory: leafDir,
      });

      expect(report.status).toBe("truncated");
      expect(report.truncated).toBe(true);
      expect(report.maxBytes).toBe(100);
      expect(report.totalRawBytes).toBe(160);
      expect(report.totalIncludedBytes).toBe(100);
      expect(report.remainingBytes).toBe(0);

      expect(report.chain).toHaveLength(3);
      expect(report.chain[0]).toMatchObject({
        path: "project/AGENTS.md",
        rawBytes: 60,
        includedBytes: 60,
        truncated: false,
      });
      expect(report.chain[1]).toMatchObject({
        path: "project/services/billing/AGENTS.md",
        rawBytes: 60,
        includedBytes: 40,
        truncated: true,
      });
      expect(report.chain[2]).toMatchObject({
        path: "project/services/billing/worker/AGENTS.md",
        rawBytes: 40,
        includedBytes: 0,
        truncated: true,
      });

      const rendered = renderCodexDoctorReport(report);
      expect(rendered).toContain("[TRUNCATED]");
      expect(rendered).toContain("ctxwise sync --compress");
    });
  });

  it("reports invalid config.toml and approaching-max-bytes warnings", async () => {
    await withTempDir("ctxwise-codex-doctor-err-", async (root) => {
      const codexHome = join(root, ".codex");
      const projectRoot = join(root, "repo");
      await mkdir(codexHome, { recursive: true });
      await mkdir(join(projectRoot, ".codex"), { recursive: true });

      await writeFile(
        join(codexHome, "config.toml"),
        "project_doc_max_bytes = 100\n",
      );
      await writeFile(
        join(projectRoot, ".codex", "config.toml"),
        "broken = [\n",
      );
      await writeFile(join(projectRoot, "AGENTS.md"), "X".repeat(90));

      const report = await runCodexDoctor({
        codexHome,
        projectRoot,
      });

      expect(report.status).toBe("error");
      expect(report.findings.map((f) => f.code)).toContain(
        "invalid-config-toml",
      );
      expect(report.findings.map((f) => f.code)).toContain(
        "approaching-max-bytes",
      );
    });
  });
});
