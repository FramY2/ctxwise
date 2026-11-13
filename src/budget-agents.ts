import { isAbsolute, relative } from "node:path";

import type { MultiAgentReport, SupportedAgentId } from "./agents.js";
import type { AuditContributor, AuditSnapshot } from "./audit-summary.js";

/** File written by `ctxwise init` / `ctxwise preset` and auto-loaded by `ctxwise budget`. */
export const DEFAULT_BUDGET_POLICY_FILE = "ctxwise.budget.yaml";

export const BUDGET_AGENTS = ["codex", "claude", "cursor"] as const;
export type BudgetAgent = (typeof BUDGET_AGENTS)[number];
export type BudgetAgentSelection = BudgetAgent | "all";

export interface BudgetAgentBreakdown {
  provenance: "estimated";
  /** Estimated startup tokens each agent loads at session start. */
  agents: Record<BudgetAgent, number>;
  /** Agent whose startup surface the budget limit was applied to. */
  budgetedAgent: BudgetAgent;
  /** `heaviest-agent` when `--agent all`, otherwise `selected-agent`. */
  mode: "heaviest-agent" | "selected-agent";
}

const AGENT_LABELS: Record<BudgetAgent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};

function agentContributors(
  report: MultiAgentReport,
  agent: Exclude<SupportedAgentId, "codex">,
): AuditContributor[] {
  return report.agents[agent].sources
    .filter((source) => source.estimatedTokens > 0)
    .map((source) => ({
      kind:
        source.kind === "guidance" ||
        source.kind === "rule" ||
        source.kind === "memory"
          ? ("guidance" as const)
          : ("source" as const),
      label: source.path,
      path: source.path,
      estimatedTokens: source.estimatedTokens,
    }));
}

function largest(contributors: AuditContributor[]): AuditContributor[] {
  const sorted = [...contributors].sort(
    (left, right) =>
      right.estimatedTokens - left.estimatedTokens ||
      left.label.localeCompare(right.label),
  );
  return sorted.slice(0, 1);
}

function nonCodexSnapshot(
  report: MultiAgentReport,
  agent: Exclude<BudgetAgent, "codex">,
): AuditSnapshot {
  const contributors = agentContributors(report, agent);
  const summary = report.agents[agent];
  return {
    provenance: "estimated",
    status: "clean",
    estimatedKnownStartupTokens: summary.estimatedStartupTokens,
    guidanceFiles: contributors.filter((item) => item.kind === "guidance")
      .length,
    skills: summary.sources.filter((source) => source.kind === "skill").length,
    plugins: 0,
    mcpServers: 0,
    unmeasuredConfigSources: 0,
    topContributors: largest(contributors),
    recommendations: [],
  };
}

/**
 * Combine the Codex audit snapshot with Claude Code and Cursor startup
 * surfaces from the multi-agent audit.
 *
 * Agents load their own startup files independently, so `all` applies the
 * budget to the heaviest single agent session instead of summing agents (a
 * synced CLAUDE.md + AGENTS.md pair is never double-counted). The largest
 * contributor is taken across every agent, and audit errors / unmeasured
 * surfaces from the Codex audit still apply.
 */
export function combineBudgetSnapshots(
  codexSnapshot: AuditSnapshot,
  report: MultiAgentReport,
  selection: BudgetAgentSelection,
): { snapshot: AuditSnapshot; breakdown: BudgetAgentBreakdown } {
  const agents: Record<BudgetAgent, number> = {
    codex: codexSnapshot.estimatedKnownStartupTokens,
    claude: report.agents.claude.estimatedStartupTokens,
    cursor: report.agents.cursor.estimatedStartupTokens,
  };
  if (selection !== "all") {
    const snapshot =
      selection === "codex"
        ? codexSnapshot
        : nonCodexSnapshot(report, selection);
    return {
      snapshot,
      breakdown: {
        provenance: "estimated",
        agents,
        budgetedAgent: selection,
        mode: "selected-agent",
      },
    };
  }
  const budgetedAgent = BUDGET_AGENTS.reduce<BudgetAgent>(
    (heaviest, agent) => (agents[agent] > agents[heaviest] ? agent : heaviest),
    "codex",
  );
  const topContributors = largest([
    ...codexSnapshot.topContributors,
    ...agentContributors(report, "claude"),
    ...agentContributors(report, "cursor"),
  ]);
  return {
    snapshot: {
      ...codexSnapshot,
      estimatedKnownStartupTokens: agents[budgetedAgent],
      topContributors,
    },
    breakdown: {
      provenance: "estimated",
      agents,
      budgetedAgent,
      mode: "heaviest-agent",
    },
  };
}

export function renderBudgetBreakdown(breakdown: BudgetAgentBreakdown): string {
  const parts = BUDGET_AGENTS.map(
    (agent) =>
      `${AGENT_LABELS[agent]} ~${breakdown.agents[agent].toLocaleString("en-US")}`,
  );
  const target =
    breakdown.mode === "heaviest-agent"
      ? `limit applied to heaviest agent: ${AGENT_LABELS[breakdown.budgetedAgent]}`
      : `limit applied to ${AGENT_LABELS[breakdown.budgetedAgent]}`;
  return `Agents (estimated startup tokens): ${parts.join(" · ")} · ${target}\n`;
}

export function relativeDisplayPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return path.replaceAll("\\", "/");
  }
  return rel.replaceAll("\\", "/");
}
