import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  applyPresetToProject,
  listBuiltInPresets,
  PRESET_ALIASES,
  renderPresetGuidanceMarkdown,
  resolvePresetName,
} from "../../src/presets.js";
import { withTempDir } from "../support/temp.js";

describe("Community Stack Presets", () => {
  it("lists all built-in stack presets with valid schemas", async () => {
    const presets = await listBuiltInPresets();
    expect(presets.length).toBeGreaterThanOrEqual(6);
    const names = presets.map((p) => p.name);
    expect(names).toContain("nextjs-typescript");
    expect(names).toContain("python-fastapi");
    expect(names).toContain("rust-cargo");
    expect(names).toContain("mcp-server-dev");
  });

  it("applies a preset to a project and optionally generates AGENTS.md and CLAUDE.md", async () => {
    await withTempDir("ctxwise-presets-", async (root) => {
      const applied = await applyPresetToProject({
        presetName: "nextjs-typescript",
        projectRoot: root,
        writeGuidance: true,
      });

      expect(applied.guidancePaths).toHaveLength(2);
      const budgetContent = await readFile(applied.budgetPath, "utf8");
      expect(budgetContent).toContain("maxKnownTokens: 3200");

      const markdown = renderPresetGuidanceMarkdown(applied.preset);
      expect(markdown).toContain("Next.js + TypeScript + Tailwind");
    });
  });

  it("resolves sveltekit-typescript as an alias for the sveltekit preset", async () => {
    await withTempDir("ctxwise-presets-alias-", async (root) => {
      const applied = await applyPresetToProject({
        presetName: "sveltekit-typescript",
        projectRoot: root,
        writeGuidance: true,
      });

      expect(applied.preset.name).toBe("sveltekit");
      expect(applied.guidancePaths).toHaveLength(2);
      const budgetContent = await readFile(applied.budgetPath, "utf8");
      expect(budgetContent).toContain("maxKnownTokens: 3000");
    });
  });

  it("throws a clear error for unknown preset names", async () => {
    await withTempDir("ctxwise-presets-err-", async (root) => {
      await expect(
        applyPresetToProject({
          presetName: "nonexistent-stack",
          projectRoot: root,
        }),
      ).rejects.toThrow(/Unknown preset/);
    });
  });

  describe("PRESET_ALIASES", () => {
    const aliases = Object.entries(PRESET_ALIASES);

    it("has at least one alias", () => {
      expect(aliases.length).toBeGreaterThan(0);
    });

    it.each(aliases)(
      "alias %s points at the built-in preset %s",
      async (alias, target) => {
        const names = (await listBuiltInPresets()).map((p) => p.name);
        expect(
          names,
          `alias "${alias}" -> missing preset "${target}"`,
        ).toContain(target);
        expect(resolvePresetName(alias)).toBe(target);
      },
    );

    it("never shadows a real preset name", async () => {
      const names = new Set((await listBuiltInPresets()).map((p) => p.name));
      const shadowing = Object.keys(PRESET_ALIASES).filter((alias) =>
        names.has(alias),
      );
      expect(shadowing).toEqual([]);
    });

    it("resolves aliases case- and whitespace-insensitively", () => {
      expect(resolvePresetName("  NextJS ")).toBe("nextjs-typescript");
      expect(resolvePresetName("\tTurboRepo\n")).toBe("monorepo-turbo");
      expect(resolvePresetName(" Rust-Cargo ")).toBe("rust-cargo");
    });
  });
});
