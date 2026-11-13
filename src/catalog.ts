import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { PriceCatalog } from "./receipt.js";

const rateSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const catalogSchema = z.object({
  schemaVersion: z.literal(1),
  effectiveDate: z.string().date(),
  sources: z.object({ api: z.string().url(), credits: z.string().url() }),
  models: z.record(
    z.string(),
    z.object({
      aliases: z.array(z.string()).default([]),
      contextWindow: z.number().int().positive(),
      apiUsdPerMillion: rateSchema,
      creditsPerMillion: rateSchema,
      longContext: z
        .object({
          thresholdInputTokens: z.number().int().positive(),
          inputMultiplier: z.number().positive(),
          outputMultiplier: z.number().positive(),
        })
        .optional(),
    }),
  ),
});

/** Bundled dated catalog used when no `--pricing` override is supplied. */
export const DEFAULT_PRICE_CATALOG_FILE = "pricing-2026-11-11.json";

export async function loadPriceCatalog(path?: string): Promise<PriceCatalog> {
  const url = path
    ? path
    : new URL(`../data/${DEFAULT_PRICE_CATALOG_FILE}`, import.meta.url);
  const raw = await readFile(url, "utf8");
  return catalogSchema.parse(JSON.parse(raw)) as PriceCatalog;
}
