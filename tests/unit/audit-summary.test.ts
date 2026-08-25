import { describe, expect, it } from "vitest";

import type { AuditReport } from "../../src/audit.js";
import {
  buildAuditSnapshot,
  renderAuditSnapshot,
} from "../../src/audit-summary.js";

const report: AuditReport = {
  provenance: "estimated",
  sources: [
    {
      kind: "config",
      contextRole: "configuration",
      path: "codex-home/config.toml",
      characters: 400,
      estimatedTokens: null,
    },
    {
      kind: "agents-guidance",
      contextRole: "prompt",
      path: "codex-home/AGENTS.md",
      characters: 1_200,
      estimatedTokens: 300,
    },
    {
      kind: "agents-guidance",
      contextRole: "prompt",
      path: "project/AGENTS.md",
      characters: 400,
      estimatedTokens: 100,
    },
  ],
  skills: [
    {
      name: "large-skill",
      path: "codex-home/skills/large-skill/SKILL.md",
      descriptionCharacters: 800,
      estimatedDiscoveryTokens: 205,
      scriptCount: 0,
    },
    {
      name: "small-skill",
      path: "project/.agents/skills/small-skill/SKILL.md",
      descriptionCharacters: 120,
      estimatedDiscoveryTokens: 35,
      scriptCount: 0,
    },
  ],
  plugins: [
    {
      name: "example",
      version: "1.0.0",
      path: "codex-home/plugins/example",
      skillCount: 2,
    },
  ],
  mcpServers: ["docs"],
  catalogDescriptionCharacters: 920,
  estimatedKnownStartupTokens: 640,
  findings: [
    {
      code: "skill-catalog-budget",
      severity: "warning",
      message: "Skill catalog metadata is above the discovery budget.",
      paths: [],
    },
    {
      code: "unmeasured-mcp-schemas",
      severity: "info",
      message: "MCP schemas are not measured.",
      paths: [],
    },
  ],
};

describe("audit snapshot", () => {
  it("ranks known startup contributors without treating unknown surfaces as zero", () => {
    const snapshot = buildAuditSnapshot(report, { top: 3 });

    expect(snapshot).toMatchObject({
      status: "attention",
      estimatedKnownStartupTokens: 640,
      guidanceFiles: 2,
      skills: 2,
      plugins: 1,
      mcpServers: 1,
      unmeasuredConfigSources: 1,
    });
    expect(snapshot.topContributors).toEqual([
      expect.objectContaining({
        kind: "guidance",
        label: "codex-home/AGENTS.md",
        estimatedTokens: 300,
      }),
      expect.objectContaining({
        kind: "skill-discovery",
        label: "large-skill",
        estimatedTokens: 205,
      }),
      expect.objectContaining({
        kind: "guidance",
        label: "project/AGENTS.md",
        estimatedTokens: 100,
      }),
    ]);
    expect(snapshot.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unused skills or plugins"),
        expect.stringContaining("prompt X-Ray"),
      ]),
    );
  });

  it("renders an actionable, evidence-labelled one-screen result", () => {
    const output = renderAuditSnapshot(buildAuditSnapshot(report, { top: 2 }));

    expect(output).toContain(
      "CtxWise snapshot · attention · ~640 known startup tokens (estimated)",
    );
    expect(output).toContain("2 guidance files · 2 skill descriptions");
    expect(output).toContain("~300 · guidance · codex-home/AGENTS.md");
    expect(output).toContain("~205 · skill discovery · large-skill");
    expect(output).toContain(
      "1 config/profile source and 1 MCP tool-schema surface are unmeasured",
    );
    expect(output).not.toContain("~0");
  });

  it("reports clean only when no warnings or errors exist", () => {
    const snapshot = buildAuditSnapshot(
      { ...report, findings: [] },
      { top: 5 },
    );

    expect(snapshot.status).toBe("clean");
    expect(snapshot.recommendations).toEqual([]);
  });
});
