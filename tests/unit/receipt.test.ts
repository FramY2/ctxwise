import { describe, expect, it } from "vitest";

import {
  calculateReceipt,
  renderReceipt,
  type PriceCatalog,
} from "../../src/receipt.js";

const catalog: PriceCatalog = {
  schemaVersion: 1,
  effectiveDate: "2026-08-08",
  sources: {
    api: "https://developers.openai.com/api/docs/models/compare",
    credits: "https://learn.chatgpt.com/docs/pricing",
  },
  models: {
    "gpt-5.6-sol": {
      aliases: ["gpt-5.6"],
      contextWindow: 1_050_000,
      apiUsdPerMillion: { input: 5, cachedInput: 0.5, output: 30 },
      creditsPerMillion: { input: 125, cachedInput: 12.5, output: 750 },
      longContext: {
        thresholdInputTokens: 272_000,
        inputMultiplier: 2,
        outputMultiplier: 1.5,
      },
    },
  },
};

const usage = {
  inputTokens: 24_763,
  cachedInputTokens: 24_448,
  outputTokens: 122,
  reasoningOutputTokens: 0,
  provenance: "exact" as const,
};

describe("calculateReceipt", () => {
  it("calculates uncached, cached, and output cost without double billing", () => {
    const receipt = calculateReceipt({
      authMode: "apikey",
      catalog,
      model: "gpt-5.6-sol",
      promptEstimate: { tokens: 5_000, provenance: "estimated" },
      usage,
    });

    expect(receipt.apiCost?.kind).toBe("billed-estimate");
    expect(receipt.apiCost?.usd).toBeCloseTo(0.017459, 6);
    expect(receipt.credits).toBeNull();
    expect(receipt.context.tokens).toBe(5_000);
    expect(receipt.context.percentUsed).toBeCloseTo(0.47619, 4);
    expect(renderReceipt(receipt)).toContain("estimated API charge");
    expect(renderReceipt(receipt)).not.toContain("credit equivalent");
  });

  it("applies long-context multipliers only to API pricing", () => {
    const receipt = calculateReceipt({
      authMode: "chatgpt",
      catalog,
      includeApiEquivalent: true,
      model: "gpt-5.6",
      promptEstimate: { tokens: 300_000, provenance: "estimated" },
      usage: {
        ...usage,
        inputTokens: 300_000,
        cachedInputTokens: 0,
        outputTokens: 10_000,
      },
    });

    expect(receipt.apiCost?.usd).toBeCloseTo(3.45, 6);
    expect(receipt.credits?.value).toBeCloseTo(45, 6);
  });

  it("does not show API-equivalent dollars for subscriptions by default", () => {
    const receipt = calculateReceipt({
      authMode: "chatgpt",
      catalog,
      model: "gpt-5.6-sol",
      planType: "plus",
      usage,
    });

    expect(receipt.apiCost).toBeNull();
    expect(renderReceipt(receipt)).not.toMatch(/\$/);
  });

  it("labels an opted-in subscription API equivalent as not charged", () => {
    const receipt = calculateReceipt({
      authMode: "chatgpt",
      catalog,
      includeApiEquivalent: true,
      model: "gpt-5.6-sol",
      planType: "pro",
      quota: {
        usedPercent: 37,
        windowDurationMins: 300,
        resetsAt: 1_900_000_000,
        provenance: "exact",
      },
      usage,
    });
    const rendered = renderReceipt(receipt);

    expect(receipt.apiCost?.kind).toBe("comparison");
    expect(rendered).toContain("comparison only; not charged");
    expect(rendered).toContain("37% used");
    expect(rendered).not.toContain("spent");
  });

  it("uses unknown rather than zero for an unpriced model", () => {
    const receipt = calculateReceipt({
      authMode: "unknown",
      catalog,
      model: "custom-model",
      usage,
    });

    expect(receipt.apiCost).toBeNull();
    expect(receipt.credits).toBeNull();
    expect(receipt.context.percentUsed).toBeNull();
    expect(renderReceipt(receipt)).toContain("unknown");
  });

  it("does not infer subscription credits when authentication is unknown", () => {
    const receipt = calculateReceipt({
      authMode: "unknown",
      catalog,
      model: "gpt-5.6-sol",
      usage,
    });

    expect(receipt.credits).toBeNull();
    expect(renderReceipt(receipt)).toContain("cost unknown");
    expect(renderReceipt(receipt)).not.toContain("credit equivalent");
  });

  it("keeps prompt context unknown instead of reusing aggregate turn input", () => {
    const receipt = calculateReceipt({
      authMode: "chatgpt",
      catalog,
      model: "gpt-5.6-sol",
      usage,
    });

    expect(receipt.context.tokens).toBeNull();
    expect(receipt.context.percentUsed).toBeNull();
    expect(renderReceipt(receipt)).toContain("prompt context unknown");
  });

  it("normalizes dated model snapshot suffixes and renders 5h + weekly quota windows", () => {
    const receipt = calculateReceipt({
      authMode: "chatgpt",
      catalog,
      model: "gpt-5.6-sol-2026-08-08",
      quota: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: 1_900_000_000,
        provenance: "exact",
        secondary: {
          usedPercent: 15,
          windowDurationMins: 10_080,
          resetsAt: 1_900_600_000,
          provenance: "exact",
        },
      },
      usage,
    });

    expect(receipt.credits?.value).toBeGreaterThan(0);
    const rendered = renderReceipt(receipt);
    expect(rendered).toContain("quota 40% used (5h 40% · weekly 15%)");
  });
});
