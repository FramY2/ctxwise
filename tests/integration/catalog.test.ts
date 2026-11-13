import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadPriceCatalog } from "../../src/catalog.js";
import { cleanupDirectories } from "../support/temp.js";

const created: string[] = [];
afterEach(() => cleanupDirectories(created));

describe("loadPriceCatalog", () => {
  it("loads and validates the bundled dated catalog", async () => {
    const catalog = await loadPriceCatalog();

    expect(catalog.effectiveDate).toBe("2026-11-11");
    expect(catalog.models["gpt-5.6-sol"]?.apiUsdPerMillion.output).toBe(30);
    expect(catalog.models["gpt-6.1-sol"]?.apiUsdPerMillion.output).toBe(10);
    expect(catalog.models["gpt-6-terra"]?.apiUsdPerMillion.output).toBe(5);
    expect(catalog.models["gpt-6-luna"]?.apiUsdPerMillion.output).toBe(0.5);
    expect(catalog.models["claude-sonnet-4-6"]?.apiUsdPerMillion.output).toBe(
      15,
    );
    expect(catalog.models["claude-opus-4-7"]?.apiUsdPerMillion.output).toBe(25);
  });

  it("still loads the archived 2026-08-08 catalog through an explicit path", async () => {
    const legacy = fileURLToPath(
      new URL("../../data/pricing-2026-08-08.json", import.meta.url),
    );
    const catalog = await loadPriceCatalog(legacy);

    expect(catalog.effectiveDate).toBe("2026-08-08");
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
