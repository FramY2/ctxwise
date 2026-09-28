import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { AuditContributor, AuditSnapshot } from "./audit-summary.js";

const tokenLimit = z.number().int().positive().max(100_000_000);
const contextBudgetPolicySchema = z
  .object({
    version: z.literal(1),
    maxKnownTokens: tokenLimit.optional(),
    maxContributorTokens: tokenLimit.optional(),
    unknown: z.enum(["warn", "fail"]).default("warn"),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.maxKnownTokens === undefined &&
      value.maxContributorTokens === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A context budget policy needs at least one numeric limit.",
      });
    }
  });

export type UnknownSurfacePolicy = "warn" | "fail";

export interface ContextBudgetPolicy {
  version: 1;
  maxKnownTokens?: number;
  maxContributorTokens?: number;
  unknown: UnknownSurfacePolicy;
}

export interface ContextBudgetOptions {
  maxKnownTokens?: number;
  maxContributorTokens?: number;
  unknown?: UnknownSurfacePolicy;
}

export interface ContextBudgetViolation {
  kind:
    | "known-startup-tokens"
    | "contributor-tokens"
    | "unknown-surfaces"
    | "audit-error";
  blocking: boolean;
  actual?: number;
  limit?: number;
  contributor?: string;
}

export interface ContextBudgetReport {
  provenance: "estimated";
  status: "within-budget" | "over-budget" | "unknown";
  estimatedKnownStartupTokens: number;
  limits: {
    maxKnownTokens?: number;
    maxContributorTokens?: number;
    unknown: UnknownSurfacePolicy;
  };
  unknownSurfaces: {
    configProfileSources: number;
    mcpToolSchemaSurfaces: number;
    total: number;
  };
  largestKnownContributor: AuditContributor | null;
  violations: ContextBudgetViolation[];
  summary: {
    total: number;
    blocking: number;
  };
}

export function parseContextBudgetPolicy(input: string): ContextBudgetPolicy {
  const parsed = contextBudgetPolicySchema.parse(parseYaml(input));
  return {
    version: parsed.version,
    ...(parsed.maxKnownTokens === undefined
      ? {}
      : { maxKnownTokens: parsed.maxKnownTokens }),
    ...(parsed.maxContributorTokens === undefined
      ? {}
      : { maxContributorTokens: parsed.maxContributorTokens }),
    unknown: parsed.unknown,
  };
}

function largestContributor(snapshot: AuditSnapshot): AuditContributor | null {
  return snapshot.topContributors.reduce<AuditContributor | null>(
    (largest, candidate) =>
      !largest || candidate.estimatedTokens > largest.estimatedTokens
        ? candidate
        : largest,
    null,
  );
}

export function evaluateContextBudget(
  snapshot: AuditSnapshot,
  options: ContextBudgetOptions,
): ContextBudgetReport {
  if (
    options.maxKnownTokens === undefined &&
    options.maxContributorTokens === undefined
  ) {
    throw new Error("A context budget needs at least one numeric limit.");
  }
  contextBudgetPolicySchema.parse({ version: 1, ...options });

  const unknown = options.unknown ?? "warn";
  const contributor = largestContributor(snapshot);
  const unknownSurfaces = {
    configProfileSources: snapshot.unmeasuredConfigSources,
    mcpToolSchemaSurfaces: snapshot.mcpServers,
    total: snapshot.unmeasuredConfigSources + snapshot.mcpServers,
  };
  const violations: ContextBudgetViolation[] = [];
  if (snapshot.status === "error") {
    violations.push({ kind: "audit-error", blocking: true });
  }

  if (
    options.maxKnownTokens !== undefined &&
    snapshot.estimatedKnownStartupTokens > options.maxKnownTokens
  ) {
    violations.push({
      kind: "known-startup-tokens",
      blocking: true,
      actual: snapshot.estimatedKnownStartupTokens,
      limit: options.maxKnownTokens,
    });
  }
  if (
    options.maxContributorTokens !== undefined &&
    contributor !== null &&
    contributor.estimatedTokens > options.maxContributorTokens
  ) {
    violations.push({
      kind: "contributor-tokens",
      blocking: true,
      actual: contributor.estimatedTokens,
      limit: options.maxContributorTokens,
      contributor: contributor.label,
    });
  }
  if (unknown === "fail" && unknownSurfaces.total > 0) {
    violations.push({ kind: "unknown-surfaces", blocking: true });
  }

  const numericViolation = violations.some(
    (violation) =>
      violation.kind === "known-startup-tokens" ||
      violation.kind === "contributor-tokens",
  );
  const blocking = violations.filter((violation) => violation.blocking).length;
  return {
    provenance: "estimated",
    status: numericViolation
      ? "over-budget"
      : snapshot.status === "error" ||
          (unknown === "fail" && unknownSurfaces.total > 0)
        ? "unknown"
        : "within-budget",
    estimatedKnownStartupTokens: snapshot.estimatedKnownStartupTokens,
    limits: {
      ...(options.maxKnownTokens === undefined
        ? {}
        : { maxKnownTokens: options.maxKnownTokens }),
      ...(options.maxContributorTokens === undefined
        ? {}
        : { maxContributorTokens: options.maxContributorTokens }),
      unknown,
    },
    unknownSurfaces,
    largestKnownContributor: contributor,
    violations,
    summary: { total: violations.length, blocking },
  };
}

function countLabel(count: number): string {
  return `${count.toLocaleString("en-US")} context ${count === 1 ? "surface" : "surfaces"}`;
}

export function renderContextBudget(report: ContextBudgetReport): string {
  const lines = [
    `CtxWise budget · ${report.status} · ~${report.estimatedKnownStartupTokens.toLocaleString("en-US")} known startup tokens (estimated)`,
  ];
  if (report.limits.maxKnownTokens !== undefined) {
    lines.push(
      `- Known startup limit: ${report.limits.maxKnownTokens.toLocaleString("en-US")} tokens`,
    );
  }
  if (report.limits.maxContributorTokens !== undefined) {
    lines.push(
      `- Largest contributor limit: ${report.limits.maxContributorTokens.toLocaleString("en-US")} tokens`,
    );
  }
  if (report.largestKnownContributor) {
    lines.push(
      `- Largest known contributor: ~${report.largestKnownContributor.estimatedTokens.toLocaleString("en-US")} · ${report.largestKnownContributor.label}`,
    );
  }
  if (report.violations.length > 0) {
    lines.push("", "Violations:");
    for (const violation of report.violations) {
      if (violation.kind === "known-startup-tokens") {
        lines.push(
          `- Known startup estimate ~${violation.actual!.toLocaleString("en-US")} exceeds ${violation.limit!.toLocaleString("en-US")} tokens.`,
        );
      } else if (violation.kind === "contributor-tokens") {
        lines.push(
          `- ${violation.contributor} ~${violation.actual!.toLocaleString("en-US")} exceeds ${violation.limit!.toLocaleString("en-US")} tokens.`,
        );
      } else if (violation.kind === "audit-error") {
        lines.push(
          "- Audit errors prevent a reliable budget result; run ctxwise audit for details.",
        );
      } else {
        lines.push(
          "- Unmeasured context surfaces are configured to fail this budget.",
        );
      }
    }
  }
  if (report.unknownSurfaces.total > 0) {
    lines.push(
      "",
      `${countLabel(report.unknownSurfaces.total)} are unmeasured; unknown is not treated as zero.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
