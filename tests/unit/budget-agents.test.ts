import { describe, expect, it } from "vitest";

import type {
  AgentSurfaceFile,
  MultiAgentReport,
  SupportedAgentId,
} from "../../src/agents.js";
import type { AuditSnapshot } from "../../src/audit-summary.js";
import { evaluateContextBudget } from "../../src/budget.js";
import {
  combineBudgetSnapshots,
  relativeDisplayPath,
  renderBudgetBreakdown,
} from "../../src/budget-agents.js";

function codexSnapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    provenance: "estimated",
    status: "clean",
    estimatedKnownStartupTokens: 0,
    guidanceFiles: 0,
    skills: 0,
    plugins: 0,
    mcpServers: 0,
    unmeasuredConfigSources: 0,
    topContributors: [],
    recommendations: [],
    ...overrides,
  };
}

function source(
  agent: AgentSurfaceFile["agent"],
  kind: AgentSurfaceFile["kind"],
  path: string,
  estimatedTokens: number,
): AgentSurfaceFile {
  return {
    agent,
    kind,
    path,
    characters: estimatedTokens * 4,
    estimatedTokens,
  };
}

function multiAgent(
  claude: AgentSurfaceFile[],
  cursor: AgentSurfaceFile[] = [],
): MultiAgentReport {
  const summarize = (agent: SupportedAgentId, sources: AgentSurfaceFile[]) => ({
    agent,
    files: sources.length,
    estimatedStartupTokens: sources.reduce(
      (sum, item) => sum + item.estimatedTokens,
      0,
    ),
    sources,
  });
  return {
    provenance: "estimated",
    agents: {
      claude: summarize("claude", claude),
      codex: summarize("codex", []),
      cursor: summarize("cursor", cursor),
    },
    parityStatus: "single-agent",
    compressionPotentialTokens: 0,
    claudeHygiene: {
      settingsFiles: [],
      misplacedMcpServersPaths: [],
      disableClaudeAiConnectors: false,
      deniedMcpServers: [],
      disableAllHooksPaths: [],
      hasPreToolUseMcpGuard: false,
      protectsClaudeSettingsInDeny: false,
      autoMemoryFiles: [],
    },
    companionSources: [],
    recommendations: [],
  };
}

describe("combineBudgetSnapshots", () => {
  it("budgets a pure Claude Code repo instead of reporting zero tokens", () => {
    const { snapshot, breakdown } = combineBudgetSnapshots(
      codexSnapshot(),
      multiAgent([
        source("claude", "guidance", "project/CLAUDE.md", 900),
        source("claude", "mcp-config", "project/.mcp.json", 150),
      ]),
      "all",
    );

    expect(snapshot.estimatedKnownStartupTokens).toBe(1050);
    expect(snapshot.topContributors[0]).toMatchObject({
      label: "project/CLAUDE.md",
      estimatedTokens: 900,
      kind: "guidance",
    });
    expect(breakdown).toMatchObject({
      agents: { codex: 0, claude: 1050, cursor: 0 },
      budgetedAgent: "claude",
      mode: "heaviest-agent",
    });
    expect(
      evaluateContextBudget(snapshot, { maxKnownTokens: 1000 }).status,
    ).toBe("over-budget");
  });

  it("applies the limit to the heaviest agent session without summing synced guidance", () => {
    const { snapshot, breakdown } = combineBudgetSnapshots(
      codexSnapshot({
        estimatedKnownStartupTokens: 700,
        topContributors: [
          {
            kind: "guidance",
            label: "project/AGENTS.md",
            path: "project/AGENTS.md",
            estimatedTokens: 700,
          },
        ],
      }),
      multiAgent(
        [source("claude", "guidance", "project/CLAUDE.md", 700)],
        [source("cursor", "rule", "project/.cursor/rules/style.mdc", 1200)],
      ),
      "all",
    );

    expect(snapshot.estimatedKnownStartupTokens).toBe(1200);
    expect(breakdown.budgetedAgent).toBe("cursor");
    expect(snapshot.topContributors[0]?.label).toBe(
      "project/.cursor/rules/style.mdc",
    );
    expect(
      evaluateContextBudget(snapshot, { maxKnownTokens: 1500 }).status,
    ).toBe("within-budget");
  });

  it("keeps Codex audit errors and unmeasured surfaces blocking under --agent all", () => {
    const { snapshot } = combineBudgetSnapshots(
      codexSnapshot({ status: "error", unmeasuredConfigSources: 1 }),
      multiAgent([source("claude", "guidance", "project/CLAUDE.md", 10)]),
      "all",
    );
    const report = evaluateContextBudget(snapshot, {
      maxKnownTokens: 100_000,
    });

    expect(report.status).toBe("unknown");
    expect(report.summary.blocking).toBe(1);
    expect(report.unknownSurfaces.configProfileSources).toBe(1);
  });

  it("budgets one selected agent in isolation", () => {
    const codex = codexSnapshot({
      status: "error",
      estimatedKnownStartupTokens: 5000,
    });
    const report = multiAgent(
      [source("claude", "guidance", "project/CLAUDE.md", 40)],
      [source("cursor", "rule", "project/.cursorrules", 60)],
    );

    const claude = combineBudgetSnapshots(codex, report, "claude");
    expect(claude.snapshot).toMatchObject({
      status: "clean",
      estimatedKnownStartupTokens: 40,
    });
    expect(claude.breakdown.mode).toBe("selected-agent");

    const cursor = combineBudgetSnapshots(codex, report, "cursor");
    expect(cursor.snapshot.estimatedKnownStartupTokens).toBe(60);

    expect(combineBudgetSnapshots(codex, report, "codex").snapshot).toBe(codex);
  });

  it("renders a compact per-agent breakdown", () => {
    const { breakdown } = combineBudgetSnapshots(
      codexSnapshot({ estimatedKnownStartupTokens: 1234 }),
      multiAgent([source("claude", "guidance", "project/CLAUDE.md", 10)]),
      "all",
    );
    expect(renderBudgetBreakdown(breakdown)).toBe(
      "Agents (estimated startup tokens): Codex ~1,234 · Claude Code ~10 · Cursor ~0 · limit applied to heaviest agent: Codex\n",
    );
  });
});

describe("relativeDisplayPath", () => {
  it("shows repository-relative policy paths with forward slashes", () => {
    const root = process.platform === "win32" ? "C:\\repo" : "/repo";
    const inside =
      process.platform === "win32"
        ? "C:\\repo\\ctxwise.budget.yaml"
        : "/repo/ctxwise.budget.yaml";
    const outside =
      process.platform === "win32"
        ? "C:\\other\\policy.yaml"
        : "/other/policy.yaml";
    expect(relativeDisplayPath(root, inside)).toBe("ctxwise.budget.yaml");
    expect(relativeDisplayPath(root, outside)).toBe(
      outside.replaceAll("\\", "/"),
    );
  });
});
