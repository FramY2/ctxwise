import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPriceCatalog } from "../../src/catalog.js";
import { cleanupDirectories } from "../support/temp.js";

const created: string[] = [];
afterEach(() => cleanupDirectories(created));

describe("loadPriceCatalog", () => {
  it("loads and validates the bundled dated catalog", async () => {
    const catalog = await loadPriceCatalog();

    expect(catalog.effectiveDate).toBe("2026-08-08");
    expect(catalog.models["gpt-5.6-sol"]?.apiUsdPerMillion.output).toBe(30);
    expect(catalog.models["gpt-6.1-sol"]?.apiUsdPerMillion.output).toBe(30);
    expect(catalog.models["gpt-6-terra"]?.apiUsdPerMillion.output).toBe(15);
    expect(catalog.models["gpt-6-luna"]?.apiUsdPerMillion.output).toBe(6);
    expect(catalog.models["claude-sonnet-4-6"]?.apiUsdPerMillion.output).toBe(
      15,
    );
    expect(catalog.models["claude-opus-4-7"]?.apiUsdPerMillion.output).toBe(75);
  });

  it("rejects a malformed override instead of accepting invented prices", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctxwise-catalog-"));
    created.push(root);
    const path = join(root, "bad.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, models: {} }));

    await expect(loadPriceCatalog(path)).rejects.toThrow();
  });
});
