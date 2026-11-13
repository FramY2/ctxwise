import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  applyPresetToProject,
  listBuiltInPresets,
  parsePresetYaml,
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

describe("built-in preset files stay consistent", () => {
  const presetsDir = fileURLToPath(new URL("../../presets/", import.meta.url));

  async function loadPresetFiles() {
    const files = (await readdir(presetsDir))
      .filter((file) => file.endsWith(".yaml"))
      .sort();
    return Promise.all(
      files.map(async (file) => ({
        file,
        preset: parsePresetYaml(await readFile(join(presetsDir, file), "utf8")),
      })),
    );
  }

  it("finds the preset files", async () => {
    expect((await loadPresetFiles()).length).toBeGreaterThan(0);
  });

  it("names every file after its preset name", async () => {
    for (const { file, preset } of await loadPresetFiles()) {
      expect(`${preset.name}.yaml`, `${file}: name is "${preset.name}"`).toBe(
        file,
      );
    }
  });

  it("uses each preset name only once", async () => {
    const seen = new Map<string, string>();
    for (const { file, preset } of await loadPresetFiles()) {
      expect(
        seen.get(preset.name),
        `${file}: name "${preset.name}" is already used by ${seen.get(preset.name)}`,
      ).toBeUndefined();
      seen.set(preset.name, file);
    }
  });

  it("keeps maxContributorTokens within maxKnownTokens", async () => {
    for (const { file, preset } of await loadPresetFiles()) {
      const { maxContributorTokens, maxKnownTokens } = preset.budget;
      expect(
        maxContributorTokens,
        `${file}: maxContributorTokens ${maxContributorTokens} > maxKnownTokens ${maxKnownTokens}`,
      ).toBeLessThanOrEqual(maxKnownTokens);
    }
  });

  it("has no blank rules", async () => {
    for (const { file, preset } of await loadPresetFiles()) {
      preset.rules.forEach((rule, index) => {
        expect(rule.trim(), `${file}: rules[${index}] is blank`).not.toBe("");
      });
    }
  });
});
