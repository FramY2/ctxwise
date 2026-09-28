import { describe, expect, it } from "vitest";

import type { AuditSnapshot } from "../../src/audit-summary.js";
import {
  evaluateContextBudget,
  parseContextBudgetPolicy,
  renderContextBudget,
} from "../../src/budget.js";

const snapshot: AuditSnapshot = {
  provenance: "estimated",
  status: "attention",
  estimatedKnownStartupTokens: 640,
  guidanceFiles: 2,
  skills: 2,
  plugins: 1,
  mcpServers: 1,
  unmeasuredConfigSources: 1,
  topContributors: [
    {
      kind: "guidance",
      label: "codex-home/AGENTS.md",
      path: "codex-home/AGENTS.md",
      estimatedTokens: 300,
    },
    {
      kind: "skill-discovery",
      label: "large-skill",
      path: "codex-home/skills/large-skill/SKILL.md",
      estimatedTokens: 205,
    },
  ],
  recommendations: [],
};

describe("context budget", () => {
  it("rejects invalid programmatic limits", () => {
    for (const maxKnownTokens of [0, -1, 1.5, NaN, Infinity, 100_000_001]) {
      expect(() =>
        evaluateContextBudget(snapshot, { maxKnownTokens }),
      ).toThrow();
    }
  });

  it("does not approve an incomplete audit", () => {
    const report = evaluateContextBudget(
      { ...snapshot, status: "error" },
      {
        maxKnownTokens: 1000,
      },
    );
    expect(report.status).toBe("unknown");
    expect(report.summary.blocking).toBe(1);
    expect(renderContextBudget(report)).toContain("Audit errors");
  });

  it("finds the largest contributor even in an unsorted supplied snapshot", () => {
    const report = evaluateContextBudget(
      { ...snapshot, topContributors: [...snapshot.topContributors].reverse() },
      {
        maxContributorTokens: 250,
      },
    );
    expect(report.status).toBe("over-budget");
    expect(report.largestKnownContributor?.estimatedTokens).toBe(300);
  });

  it("keeps estimates and unknown surfaces distinct while reporting deterministic violations", () => {
    const report = evaluateContextBudget(snapshot, {
      maxKnownTokens: 600,
      maxContributorTokens: 250,
      unknown: "warn",
    });

    expect(report).toMatchObject({
      provenance: "estimated",
      status: "over-budget",
      estimatedKnownStartupTokens: 640,
      unknownSurfaces: {
        configProfileSources: 1,
        mcpToolSchemaSurfaces: 1,
        total: 2,
      },
      summary: { total: 2, blocking: 2 },
    });
    expect(report.violations).toEqual([
      expect.objectContaining({
        kind: "known-startup-tokens",
        actual: 640,
        limit: 600,
        blocking: true,
      }),
      expect.objectContaining({
        kind: "contributor-tokens",
        contributor: "codex-home/AGENTS.md",
        actual: 300,
        limit: 250,
        blocking: true,
      }),
    ]);
    expect(renderContextBudget(report)).toContain(
      "2 context surfaces are unmeasured; unknown is not treated as zero.",
    );
  });

  it("makes unmeasured surfaces blocking only when explicitly requested", () => {
    const report = evaluateContextBudget(snapshot, {
      maxKnownTokens: 700,
      unknown: "fail",
    });

    expect(report.status).toBe("unknown");
    expect(report.summary).toEqual({ total: 1, blocking: 1 });
    expect(report.violations).toEqual([
      expect.objectContaining({
        kind: "unknown-surfaces",
        blocking: true,
      }),
    ]);
  });

  it("parses a strict versioned YAML policy without allowing unknown keys", () => {
    expect(
      parseContextBudgetPolicy(`
version: 1
maxKnownTokens: 1200
maxContributorTokens: 500
unknown: warn
`),
    ).toEqual({
      version: 1,
      maxKnownTokens: 1200,
      maxContributorTokens: 500,
      unknown: "warn",
    });
    expect(() =>
      parseContextBudgetPolicy(
        "version: 1\nmaxKnownTokens: 1200\nextra: true\n",
      ),
    ).toThrow(/Unknown key|Unrecognized key/i);
  });

  it("rejects policies with no numeric limit", () => {
    expect(() =>
      parseContextBudgetPolicy("version: 1\nunknown: warn\n"),
    ).toThrow(/at least one numeric limit/i);
  });
});
