import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRICE_CATALOG_FILE,
  loadPriceCatalog,
} from "../../src/catalog.js";
import { calculateReceipt } from "../../src/receipt.js";

const verifiedRates: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "claude-opus-4-7": { input: 5, cachedInput: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cachedInput: 0.5, output: 25 },
  "claude-opus-5-5": { input: 4, cachedInput: 0.4, output: 20 },
  "claude-sonnet-5-5": { input: 2, cachedInput: 0.2, output: 10 },
  "claude-sonnet-4-6": { input: 3, cachedInput: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cachedInput: 0.1, output: 5 },
  "claude-haiku-5-5": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-6-terra": { input: 1, cachedInput: 0.05, output: 5 },
  "gpt-6.1-terra": { input: 1, cachedInput: 0.05, output: 5 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

describe("bundled 2026-11-11 pricing catalog", () => {
  it("is the default catalog", async () => {
    const catalog = await loadPriceCatalog();
    expect(DEFAULT_PRICE_CATALOG_FILE).toBe("pricing-2026-11-11.json");
    expect(catalog.effectiveDate).toBe("2026-11-11");
  });

  it.each(Object.entries(verifiedRates))(
    "carries the verified USD per 1M token rates for %s",
    async (model, rates) => {
      const catalog = await loadPriceCatalog();
      expect(catalog.models[model]?.apiUsdPerMillion).toEqual(rates);
    },
  );

  it("keeps every alias unique so model resolution is unambiguous", async () => {
    const catalog = await loadPriceCatalog();
    const seen = new Map<string, string>();
    for (const [model, entry] of Object.entries(catalog.models)) {
      expect(seen.has(model), `${model} collides with an alias`).toBe(false);
      seen.set(model, model);
      for (const alias of entry.aliases) {
        expect(
          seen.has(alias),
          `${alias} (${model}) collides with ${seen.get(alias)}`,
        ).toBe(false);
        seen.set(alias, model);
      }
    }
  });

  it("resolves the short Claude aliases to the newest generation", async () => {
    const catalog = await loadPriceCatalog();
    const usage = {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      provenance: "exact" as const,
    };
    const opus = calculateReceipt({
      authMode: "apikey",
      catalog,
      model: "opus",
      usage,
    });
    expect(opus.apiCost?.usd).toBeCloseTo(0.4, 6);
    const luna = calculateReceipt({
      authMode: "apikey",
      catalog,
      model: "gpt-6-luna",
      usage,
    });
    expect(luna.apiCost?.usd).toBeCloseTo(0.01, 6);
  });
});
