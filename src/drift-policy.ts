import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { CapabilityDriftChange, CapabilityDriftReport } from "./drift.js";

const RULE_PRECEDENCE: Record<DriftChangeDecision, number> = {
  deny: 3,
  warn: 2,
  allow: 1,
  unmatched: 0,
};

const thresholdLimit = z.number().int().nonnegative().max(100_000_000);
const driftScopeSchema = z.enum(["codex-home", "project"]);
const driftChangeTypeSchema = z.enum(["added", "removed", "changed"]);
const driftActionSchema = z.enum(["allow", "deny", "warn"]);

export function validateDriftPathPattern(pattern: string): string | null {
  if (pattern.length === 0 || pattern.trim().length === 0) {
    return "Path pattern cannot be empty.";
  }
  if (pattern.includes("\0")) {
    return "Path pattern cannot contain null bytes.";
  }
  if (pattern.includes("\\")) {
    return "Path pattern must use '/' separators and cannot contain '\\'.";
  }
  if (pattern.startsWith("/")) {
    return "Path pattern must be relative and cannot start with '/'.";
  }
  if (/^[A-Za-z]:/.test(pattern)) {
    return "Path pattern cannot include a drive prefix.";
  }
  const segments = pattern.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return "Path pattern cannot contain empty path segments.";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "Path pattern cannot contain '.' or '..' traversal segments.";
  }
  return null;
}

const policyPathPatternSchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    const issue = validateDriftPathPattern(value);
    if (issue) {
      context.addIssue({
        code: "custom",
        message: issue,
      });
    }
  });

const driftPolicyRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    action: driftActionSchema,
    scope: driftScopeSchema.optional(),
    paths: z.array(policyPathPatternSchema).min(1),
    changes: z.array(driftChangeTypeSchema).min(1).optional(),
    reason: z.string().trim().min(1),
  })
  .strict();

const driftPolicySchema = z
  .object({
    version: z.literal(1),
    maxBytesDelta: thresholdLimit.optional(),
    maxAdded: thresholdLimit.optional(),
    maxRemoved: thresholdLimit.optional(),
    maxChanged: thresholdLimit.optional(),
    rules: z.array(driftPolicyRuleSchema),
  })
  .strict();

export type DriftRuleAction = "allow" | "deny" | "warn";
export type DriftChangeDecision = DriftRuleAction | "unmatched";

export interface DriftPolicyRule {
  id: string;
  action: DriftRuleAction;
  scope?: "codex-home" | "project";
  paths: string[];
  changes?: Array<"added" | "removed" | "changed">;
  reason: string;
}

export interface DriftPolicy {
  version: 1;
  maxBytesDelta?: number;
  maxAdded?: number;
  maxRemoved?: number;
  maxChanged?: number;
  rules: DriftPolicyRule[];
}

export interface DriftChangeEvaluation {
  change: CapabilityDriftChange["change"];
  scope: CapabilityDriftChange["scope"];
  path: string;
  decision: DriftChangeDecision;
  blocking: boolean;
  ruleId?: string;
  reason: string;
}

export interface DriftThresholdViolation {
  kind: "max-bytes-delta" | "max-added" | "max-removed" | "max-changed";
  blocking: true;
  actual: number;
  limit: number;
  signedDelta?: number;
}

export interface DriftPolicyEvaluation {
  schemaVersion: 1;
  status: "allowed" | "warn" | "blocked";
  blocking: boolean;
  decisions: DriftChangeEvaluation[];
  thresholdViolations: DriftThresholdViolation[];
  summary: {
    allowed: number;
    warned: number;
    denied: number;
    unmatched: number;
    thresholdViolations: number;
    blocking: number;
    totalChanges: number;
  };
}

function normalizeRule(
  rule: z.infer<typeof driftPolicyRuleSchema>,
): DriftPolicyRule {
  return {
    id: rule.id,
    action: rule.action,
    ...(rule.scope === undefined ? {} : { scope: rule.scope }),
    paths: [...rule.paths],
    ...(rule.changes === undefined ? {} : { changes: [...rule.changes] }),
    reason: rule.reason,
  };
}

function normalizePolicy(
  parsed: z.infer<typeof driftPolicySchema>,
): DriftPolicy {
  return {
    version: parsed.version,
    ...(parsed.maxBytesDelta === undefined
      ? {}
      : { maxBytesDelta: parsed.maxBytesDelta }),
    ...(parsed.maxAdded === undefined ? {} : { maxAdded: parsed.maxAdded }),
    ...(parsed.maxRemoved === undefined
      ? {}
      : { maxRemoved: parsed.maxRemoved }),
    ...(parsed.maxChanged === undefined
      ? {}
      : { maxChanged: parsed.maxChanged }),
    rules: parsed.rules.map(normalizeRule),
  };
}

export function parseDriftPolicy(input: string): DriftPolicy {
  const parsed = driftPolicySchema.parse(parseYaml(input));
  return normalizePolicy(parsed);
}

function matchSegment(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let starIdx = -1;
  let matchIdx = 0;
  while (v < value.length) {
    const pc = pattern[p];
    if (pc === "?" || pc === value[v]) {
      p += 1;
      v += 1;
    } else if (pc === "*") {
      starIdx = p;
      matchIdx = v;
      p += 1;
    } else if (starIdx !== -1) {
      p = starIdx + 1;
      matchIdx += 1;
      v = matchIdx;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") {
    p += 1;
  }
  return p === pattern.length;
}

/**
 * Deterministic, ReDoS-free POSIX glob matcher supporting `*`, `**`, and `?`.
 */
export function matchDriftGlob(pattern: string, targetPath: string): boolean {
  const issue = validateDriftPathPattern(pattern);
  if (issue) {
    throw new Error(`Invalid drift policy path pattern "${pattern}": ${issue}`);
  }
  if (
    targetPath.length === 0 ||
    targetPath.includes("\0") ||
    targetPath.includes("\\") ||
    targetPath.startsWith("/")
  ) {
    return false;
  }
  const pathSegs = targetPath.split("/");
  if (
    pathSegs.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return false;
  }

  const patSegs: string[] = [];
  for (const seg of pattern.split("/")) {
    if (seg === "**" && patSegs[patSegs.length - 1] === "**") continue;
    patSegs.push(seg);
  }

  const pLen = patSegs.length;
  const sLen = pathSegs.length;
  const dp: boolean[][] = Array.from({ length: pLen + 1 }, () =>
    Array<boolean>(sLen + 1).fill(false),
  );
  dp[0]![0] = true;

  for (let i = 1; i <= pLen; i++) {
    const pat = patSegs[i - 1]!;
    if (pat === "**") {
      const trailingDirGlob = i === pLen && pLen > 1;
      if (trailingDirGlob) {
        for (let j = 1; j <= sLen; j++) {
          dp[i]![j] = dp[i - 1]![j - 1]! || dp[i]![j - 1]!;
        }
      } else {
        for (let j = 0; j <= sLen; j++) {
          dp[i]![j] = dp[i - 1]![j]! || (j > 0 && dp[i]![j - 1]!);
        }
      }
    } else {
      for (let j = 1; j <= sLen; j++) {
        dp[i]![j] = dp[i - 1]![j - 1]! && matchSegment(pat, pathSegs[j - 1]!);
      }
    }
  }

  return dp[pLen]![sLen]!;
}

function ruleMatchesChange(
  rule: DriftPolicyRule,
  change: CapabilityDriftChange,
): boolean {
  if (rule.scope !== undefined && rule.scope !== change.scope) return false;
  if (rule.changes !== undefined && !rule.changes.includes(change.change)) {
    return false;
  }
  return rule.paths.some((pattern) => matchDriftGlob(pattern, change.path));
}

function evaluateChange(
  change: CapabilityDriftChange,
  rules: readonly DriftPolicyRule[],
): DriftChangeEvaluation {
  let winningRule: DriftPolicyRule | undefined;
  for (const rule of rules) {
    if (!ruleMatchesChange(rule, change)) continue;
    if (
      !winningRule ||
      RULE_PRECEDENCE[rule.action] > RULE_PRECEDENCE[winningRule.action]
    ) {
      winningRule = rule;
    }
  }

  if (!winningRule) {
    return {
      change: change.change,
      scope: change.scope,
      path: change.path,
      decision: "unmatched",
      blocking: true,
      reason: "No drift policy rule matched this change (fail-closed default).",
    };
  }

  const decision = winningRule.action;
  return {
    change: change.change,
    scope: change.scope,
    path: change.path,
    decision,
    blocking: decision === "deny",
    ruleId: winningRule.id,
    reason: winningRule.reason,
  };
}

export function evaluateDriftPolicy(
  report: CapabilityDriftReport,
  policy: DriftPolicy,
): DriftPolicyEvaluation {
  const validPolicy = normalizePolicy(driftPolicySchema.parse(policy));
  const decisions = report.changes.map((change) =>
    evaluateChange(change, validPolicy.rules),
  );

  const thresholdViolations: DriftThresholdViolation[] = [];
  if (
    validPolicy.maxAdded !== undefined &&
    report.summary.added > validPolicy.maxAdded
  ) {
    thresholdViolations.push({
      kind: "max-added",
      blocking: true,
      actual: report.summary.added,
      limit: validPolicy.maxAdded,
    });
  }
  if (
    validPolicy.maxRemoved !== undefined &&
    report.summary.removed > validPolicy.maxRemoved
  ) {
    thresholdViolations.push({
      kind: "max-removed",
      blocking: true,
      actual: report.summary.removed,
      limit: validPolicy.maxRemoved,
    });
  }
  if (
    validPolicy.maxChanged !== undefined &&
    report.summary.changed > validPolicy.maxChanged
  ) {
    thresholdViolations.push({
      kind: "max-changed",
      blocking: true,
      actual: report.summary.changed,
      limit: validPolicy.maxChanged,
    });
  }
  const absBytesDelta = Math.abs(report.summary.bytesDelta);
  if (
    validPolicy.maxBytesDelta !== undefined &&
    absBytesDelta > validPolicy.maxBytesDelta
  ) {
    thresholdViolations.push({
      kind: "max-bytes-delta",
      blocking: true,
      actual: absBytesDelta,
      limit: validPolicy.maxBytesDelta,
      signedDelta: report.summary.bytesDelta,
    });
  }

  const allowed = decisions.filter((d) => d.decision === "allow").length;
  const warned = decisions.filter((d) => d.decision === "warn").length;
  const denied = decisions.filter((d) => d.decision === "deny").length;
  const unmatched = decisions.filter((d) => d.decision === "unmatched").length;
  const blocking = denied + unmatched + thresholdViolations.length;
  const status: DriftPolicyEvaluation["status"] =
    blocking > 0 ? "blocked" : warned > 0 ? "warn" : "allowed";

  return {
    schemaVersion: 1,
    status,
    blocking: blocking > 0,
    decisions,
    thresholdViolations,
    summary: {
      allowed,
      warned,
      denied,
      unmatched,
      thresholdViolations: thresholdViolations.length,
      blocking,
      totalChanges: decisions.length,
    },
  };
}

export function renderDriftPolicyReport(
  report: CapabilityDriftReport,
  evaluation: DriftPolicyEvaluation,
  policyLabel?: string,
): string {
  const { summary } = report;
  const deltaSign = summary.bytesDelta >= 0 ? "+" : "";
  const lines = [
    `CtxWise drift · ${report.status} · policy: ${evaluation.status} · ${summary.total} changes (+${summary.added} -${summary.removed} ~${summary.changed}) · ${deltaSign}${summary.bytesDelta.toLocaleString("en-US")} bytes`,
  ];

  for (const decision of evaluation.decisions) {
    const marker =
      decision.change === "added"
        ? "+"
        : decision.change === "removed"
          ? "-"
          : "~";
    const ruleTag = decision.ruleId ? ` (${decision.ruleId})` : "";
    lines.push(
      `${marker} [${decision.decision.toUpperCase()}] ${decision.scope}/${decision.path}${ruleTag} — ${decision.reason}`,
    );
  }

  if (evaluation.thresholdViolations.length > 0) {
    lines.push("", "Threshold violations:");
    for (const violation of evaluation.thresholdViolations) {
      if (violation.kind === "max-bytes-delta") {
        const signed = violation.signedDelta ?? violation.actual;
        const sign = signed >= 0 ? "+" : "";
        lines.push(
          `- Byte delta |${sign}${signed.toLocaleString("en-US")}| (${violation.actual.toLocaleString("en-US")} bytes) exceeds maxBytesDelta limit of ${violation.limit.toLocaleString("en-US")} bytes.`,
        );
      } else {
        lines.push(
          `- ${violation.kind} count ${violation.actual.toLocaleString("en-US")} exceeds limit of ${violation.limit.toLocaleString("en-US")}.`,
        );
      }
    }
  }

  if (policyLabel) {
    lines.push(`Policy: ${policyLabel}`);
  }

  return `${lines.join("\n")}\n`;
}
