export type Provenance = "exact" | "estimated" | "unknown";
export type AuthMode = "apikey" | "chatgpt" | "unknown";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  provenance: Provenance;
}

export interface TokenRate {
  input: number;
  cachedInput: number;
  output: number;
}

export interface ModelPrice {
  aliases: string[];
  contextWindow: number;
  apiUsdPerMillion: TokenRate;
  creditsPerMillion: TokenRate;
  longContext?: {
    thresholdInputTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
}

export interface PriceCatalog {
  schemaVersion: 1;
  effectiveDate: string;
  sources: { api: string; credits: string };
  models: Record<string, ModelPrice>;
}

export interface QuotaWindowSnapshot {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  provenance: Provenance;
}

export interface QuotaSnapshot extends QuotaWindowSnapshot {
  primary?: QuotaWindowSnapshot | null;
  secondary?: QuotaWindowSnapshot | null;
}

export interface Receipt {
  authMode: AuthMode;
  model: string;
  planType: string | null;
  usage: TokenUsage;
  context: {
    tokens: number | null;
    window: number | null;
    percentUsed: number | null;
    provenance: Provenance;
  };
  credits: { value: number; provenance: "estimated" } | null;
  apiCost: {
    usd: number;
    kind: "billed-estimate" | "comparison";
    provenance: "estimated";
  } | null;
  quota: QuotaSnapshot | null;
  catalog: {
    effectiveDate: string;
    sources: PriceCatalog["sources"];
  };
  warnings: string[];
}

export interface ReceiptInput {
  authMode: AuthMode;
  catalog: PriceCatalog;
  includeApiEquivalent?: boolean;
  model: string;
  planType?: string | null;
  promptEstimate?: { tokens: number; provenance: "estimated" } | null;
  quota?: QuotaSnapshot | null;
  usage: TokenUsage;
}

function resolvePrice(
  catalog: PriceCatalog,
  requestedModel: string,
): ModelPrice | null {
  const candidates = [
    requestedModel,
    requestedModel.replace(/-\d{4}-?\d{2}-?\d{2}$/, ""),
  ];
  for (const candidate of candidates) {
    const exact = catalog.models[candidate];
    if (exact) return exact;
    const byAlias = Object.values(catalog.models).find((entry) =>
      entry.aliases.includes(candidate),
    );
    if (byAlias) return byAlias;
  }
  return null;
}

function calculateRatedValue(
  usage: TokenUsage,
  rates: TokenRate,
  model: ModelPrice,
  applyLongContextMultiplier = false,
): number {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const isLong = applyLongContextMultiplier && model.longContext !== undefined;
  const inputMultiplier = isLong ? model.longContext!.inputMultiplier : 1;
  const outputMultiplier = isLong ? model.longContext!.outputMultiplier : 1;

  return (
    (uncached * rates.input * inputMultiplier +
      cached * rates.cachedInput * inputMultiplier +
      usage.outputTokens * rates.output * outputMultiplier) /
    1_000_000
  );
}

export function calculateReceipt(input: ReceiptInput): Receipt {
  const price = resolvePrice(input.catalog, input.model);
  const warnings = [
    "Token-derived values exclude unobserved tool-call fees and cache-write classes.",
  ];
  if (!price)
    warnings.push(`No dated price entry is available for ${input.model}.`);

  const contextWindow = price?.contextWindow ?? null;
  const promptTokens = input.promptEstimate?.tokens ?? null;
  if (promptTokens !== null) {
    warnings.push(
      "Prompt X-Ray uses a character proxy; model tokenizer and separately supplied tool schemas may differ.",
    );
  }
  const percentUsed =
    contextWindow && promptTokens !== null
      ? (promptTokens / contextWindow) * 100
      : null;
  const credits =
    price && input.authMode === "chatgpt"
      ? {
          value: calculateRatedValue(
            input.usage,
            price.creditsPerMillion,
            price,
          ),
          provenance: "estimated" as const,
        }
      : null;

  const showApiCost =
    input.authMode === "apikey" ||
    (input.authMode === "chatgpt" && input.includeApiEquivalent === true);
  if (price?.longContext && showApiCost) {
    warnings.push(
      promptTokens === null
        ? "Long-context API multiplier status is unknown; the base rate was used."
        : "Long-context API multiplier selection uses the pre-turn prompt estimate; later model calls may cross the threshold.",
    );
  }
  const applyLongContextMultiplier = Boolean(
    price?.longContext &&
    promptTokens !== null &&
    promptTokens > price.longContext.thresholdInputTokens,
  );
  const apiCost =
    price && showApiCost
      ? {
          usd: calculateRatedValue(
            input.usage,
            price.apiUsdPerMillion,
            price,
            applyLongContextMultiplier,
          ),
          kind:
            input.authMode === "apikey"
              ? ("billed-estimate" as const)
              : ("comparison" as const),
          provenance: "estimated" as const,
        }
      : null;

  return {
    authMode: input.authMode,
    model: input.model,
    planType: input.planType ?? null,
    usage: input.usage,
    context: {
      tokens: promptTokens,
      window: contextWindow,
      percentUsed,
      provenance: input.promptEstimate?.provenance ?? "unknown",
    },
    credits,
    apiCost,
    quota: input.quota ?? null,
    catalog: {
      effectiveDate: input.catalog.effectiveDate,
      sources: input.catalog.sources,
    },
    warnings,
  };
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function compactDecimal(value: number, digits: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}

export function renderReceipt(receipt: Receipt): string {
  const context =
    receipt.context.tokens === null
      ? "prompt context unknown"
      : receipt.context.window
        ? `prompt ≈ ${integer.format(receipt.context.tokens)} / ${integer.format(receipt.context.window)} (${compactDecimal(receipt.context.percentUsed!, 1)}%)`
        : `prompt ≈ ${integer.format(receipt.context.tokens)} tokens (window unknown)`;
  const parts = [
    "CtxWise receipt",
    context,
    `${integer.format(receipt.usage.inputTokens)} input (${integer.format(receipt.usage.cachedInputTokens)} cached) + ${integer.format(receipt.usage.outputTokens)} output`,
  ];

  if (receipt.authMode === "chatgpt") {
    parts.push(
      receipt.credits
        ? `credit equivalent ≈ ${compactDecimal(receipt.credits.value, 4)}`
        : "credit equivalent unknown",
      receipt.quota
        ? `quota ${compactDecimal(receipt.quota.usedPercent, 1)}% used`
        : "quota unknown",
    );
    if (receipt.apiCost?.kind === "comparison") {
      parts.push(
        `API equivalent ≈ $${receipt.apiCost.usd.toFixed(6)} (comparison only; not charged)`,
      );
    }
  } else if (
    receipt.authMode === "apikey" &&
    receipt.apiCost?.kind === "billed-estimate"
  ) {
    parts.push(`estimated API charge ≈ $${receipt.apiCost.usd.toFixed(6)}`);
  } else {
    parts.push("cost unknown");
  }

  parts.push(`rates ${receipt.catalog.effectiveDate}`);

  return parts.join(" · ");
}
