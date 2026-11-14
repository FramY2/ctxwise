import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CapabilityDriftReport } from "../../src/drift.js";
import {
  evaluateDriftPolicy,
  matchDriftGlob,
  parseDriftPolicy,
  renderDriftPolicyReport,
  validateDriftPathPattern,
  type DriftPolicy,
} from "../../src/drift-policy.js";

function makeReport(
  changes: CapabilityDriftReport["changes"],
  bytesDelta = 0,
): CapabilityDriftReport {
  return {
    schemaVersion: 1,
    status: changes.length === 0 ? "clean" : "drifted",
    baselineGeneratedAt: "2026-11-13T10:00:00.000Z",
    currentGeneratedAt: "2026-11-14T10:00:00.000Z",
    summary: {
      added: changes.filter((c) => c.change === "added").length,
      removed: changes.filter((c) => c.change === "removed").length,
      changed: changes.filter((c) => c.change === "changed").length,
      total: changes.length,
      bytesDelta,
    },
    changes,
  };
}

describe("parseDriftPolicy and path validation", () => {
  it("parses a strict versioned YAML drift policy including zero thresholds", () => {
    const policy = parseDriftPolicy(`
version: 1
maxAdded: 0
maxRemoved: 0
maxChanged: 2
maxBytesDelta: 512
rules:
  - id: allow-rules
    action: allow
    scope: project
    paths:
      - .claude/rules/**/*.md
    changes:
      - added
      - changed
    reason: "Reviewed rule updates are allowed."
  - id: warn-agents
    action: warn
    paths:
      - AGENTS.md
    reason: "Warn on AGENTS.md changes."
`);

    expect(policy).toEqual({
      version: 1,
      maxAdded: 0,
      maxRemoved: 0,
      maxChanged: 2,
      maxBytesDelta: 512,
      rules: [
        {
          id: "allow-rules",
          action: "allow",
          scope: "project",
          paths: [".claude/rules/**/*.md"],
          changes: ["added", "changed"],
          reason: "Reviewed rule updates are allowed.",
        },
        {
          id: "warn-agents",
          action: "warn",
          paths: ["AGENTS.md"],
          reason: "Warn on AGENTS.md changes.",
        },
      ],
    });
  });

  it("rejects unknown top-level and rule-level keys (fail-closed .strict())", () => {
    expect(() =>
      parseDriftPolicy(`
version: 1
defaultAction: allow
rules: []
`),
    ).toThrow(/Unrecognized|Unknown key/i);

    expect(() =>
      parseDriftPolicy(`
version: 1
rules:
  - id: bad-rule
    action: allow
    paths: ["AGENTS.md"]
    reason: "ok"
    extraField: true
`),
    ).toThrow(/Unrecognized|Unknown key/i);
  });

  it("rejects unsupported versions, empty YAML, missing rules, and invalid thresholds", () => {
    expect(() => parseDriftPolicy("")).toThrow();
    expect(() => parseDriftPolicy("version: 2\nrules: []\n")).toThrow();
    expect(() => parseDriftPolicy("version: 1\n")).toThrow();
    expect(() =>
      parseDriftPolicy("version: 1\nmaxAdded: -1\nrules: []\n"),
    ).toThrow();
    expect(() =>
      parseDriftPolicy("version: 1\nmaxBytesDelta: 1.5\nrules: []\n"),
    ).toThrow();
    expect(() =>
      parseDriftPolicy(`
version: 1
rules:
  - id: missing-paths
    action: allow
    paths: []
    reason: "Invalid empty paths"
`),
    ).toThrow();
    expect(() =>
      parseDriftPolicy(`
version: 1
rules:
  - id: empty-changes
    action: allow
    paths: ["AGENTS.md"]
    changes: []
    reason: "Invalid empty changes"
`),
    ).toThrow();
  });

  it("rejects backslashes, leading slashes, empty segments, and .. or . traversal in rules[].paths", () => {
    const badPatterns = [
      "",
      "   ",
      ".claude\\settings.json",
      "foo\\bar",
      "/AGENTS.md",
      "/.claude/settings.json",
      "a//b",
      ".claude/",
      "../secret.md",
      ".claude/../secret.md",
      "a/..",
      "..",
      "./AGENTS.md",
      "a/./b",
      ".",
      "C:/AGENTS.md",
      "AGENTS.md\0.txt",
    ];

    for (const pattern of badPatterns) {
      expect(validateDriftPathPattern(pattern), pattern).not.toBeNull();
      expect(() =>
        parseDriftPolicy(
          JSON.stringify({
            version: 1,
            rules: [
              {
                id: "bad-path",
                action: "allow",
                paths: [pattern],
                reason: "Should fail validation",
              },
            ],
          }),
        ),
      ).toThrow();
    }
  });

  it("validates the bundled examples/ctxwise.drift.yaml policy", async () => {
    const exampleYaml = await readFile(
      fileURLToPath(
        new URL("../../examples/ctxwise.drift.yaml", import.meta.url),
      ),
      "utf8",
    );
    const policy = parseDriftPolicy(exampleYaml);

    expect(policy.version).toBe(1);
    expect(policy.rules.length).toBeGreaterThanOrEqual(4);
  });
});

describe("matchDriftGlob", () => {
  it("matches exact paths, *, **, ?, and dotfiles deterministically", () => {
    expect(matchDriftGlob("AGENTS.md", "AGENTS.md")).toBe(true);
    expect(matchDriftGlob("AGENTS.md", "sub/AGENTS.md")).toBe(false);

    expect(matchDriftGlob("*.md", "AGENTS.md")).toBe(true);
    expect(matchDriftGlob("*.md", ".claude/CLAUDE.md")).toBe(false);

    expect(matchDriftGlob("**/*.md", "CLAUDE.md")).toBe(true);
    expect(matchDriftGlob("**/*.md", ".claude/rules/sec.md")).toBe(true);
    expect(
      matchDriftGlob(".claude/rules/**/*.md", ".claude/rules/sec.md"),
    ).toBe(true);
    expect(
      matchDriftGlob(".claude/rules/**/*.md", ".claude/rules/team/deep/sec.md"),
    ).toBe(true);
    expect(
      matchDriftGlob(".claude/rules/**/*.md", ".claude/rules/sec.txt"),
    ).toBe(false);

    expect(matchDriftGlob(".claude/**", ".claude/settings.json")).toBe(true);
    expect(matchDriftGlob(".claude/**", ".claude/settings.local.json")).toBe(
      true,
    );
    expect(matchDriftGlob(".claude/**", ".claude")).toBe(false);

    expect(matchDriftGlob("**", "AGENTS.md")).toBe(true);
    expect(matchDriftGlob("**/**", ".claude/settings.json")).toBe(true);
    expect(matchDriftGlob("a/**/b/**", "a/b/c")).toBe(true);
    expect(matchDriftGlob("a/**/b/**", "a/b")).toBe(false);

    expect(matchDriftGlob("skills/?/SKILL.md", "skills/a/SKILL.md")).toBe(true);
    expect(matchDriftGlob("skills/?/SKILL.md", "skills/ab/SKILL.md")).toBe(
      false,
    );

    expect(
      matchDriftGlob("docs/v1.0+(draft)[1].md", "docs/v1.0+(draft)[1].md"),
    ).toBe(true);
  });

  it("handles malformed target paths fail-closed and rejects invalid patterns", () => {
    expect(matchDriftGlob("**", "")).toBe(false);
    expect(matchDriftGlob("**", "/AGENTS.md")).toBe(false);
    expect(matchDriftGlob("**", "a\\b")).toBe(false);
    expect(matchDriftGlob("**", "../AGENTS.md")).toBe(false);
    expect(matchDriftGlob("**", "a//b")).toBe(false);

    expect(() => matchDriftGlob("../AGENTS.md", "AGENTS.md")).toThrow();
    expect(() => matchDriftGlob("a\\b", "a/b")).toThrow();
  });
});

describe("evaluateDriftPolicy", () => {
  it("allows clean reports with zero changes", () => {
    const policy: DriftPolicy = { version: 1, maxAdded: 0, rules: [] };
    const result = evaluateDriftPolicy(makeReport([], 0), policy);

    expect(result).toEqual({
      schemaVersion: 1,
      status: "allowed",
      blocking: false,
      decisions: [],
      thresholdViolations: [],
      summary: {
        allowed: 0,
        warned: 0,
        denied: 0,
        unmatched: 0,
        thresholdViolations: 0,
        blocking: 0,
        totalChanges: 0,
      },
    });
  });

  it("defaults unmatched changes to fail-closed blocking", () => {
    const report = makeReport(
      [
        {
          change: "added",
          scope: "project",
          path: ".mcp.json",
          after: { sha256: "a".repeat(64), bytes: 100, redacted: false },
        },
      ],
      100,
    );
    const evaluation = evaluateDriftPolicy(report, { version: 1, rules: [] });

    expect(evaluation.status).toBe("blocked");
    expect(evaluation.blocking).toBe(true);
    expect(evaluation.summary).toMatchObject({
      unmatched: 1,
      blocking: 1,
      totalChanges: 1,
    });
    expect(evaluation.decisions[0]).toMatchObject({
      decision: "unmatched",
      blocking: true,
      path: ".mcp.json",
    });
  });

  it("enforces precedence deny > warn > allow > unmatched regardless of rule order", () => {
    const report = makeReport(
      [
        {
          change: "changed",
          scope: "project",
          path: ".claude/settings.json",
          before: { sha256: "a".repeat(64), bytes: 100, redacted: false },
          after: { sha256: "b".repeat(64), bytes: 110, redacted: false },
        },
        {
          change: "changed",
          scope: "project",
          path: "CLAUDE.md",
          before: { sha256: "a".repeat(64), bytes: 100, redacted: false },
          after: { sha256: "c".repeat(64), bytes: 110, redacted: false },
        },
        {
          change: "added",
          scope: "project",
          path: ".claude/rules/testing.md",
          after: { sha256: "d".repeat(64), bytes: 50, redacted: false },
        },
        {
          change: "removed",
          scope: "codex-home",
          path: "config.toml",
          before: { sha256: "e".repeat(64), bytes: 80, redacted: true },
        },
      ],
      -10,
    );

    const policy: DriftPolicy = {
      version: 1,
      maxAdded: 10,
      maxRemoved: 10,
      maxChanged: 10,
      maxBytesDelta: 100_000,
      rules: [
        {
          id: "allow-all-project",
          action: "allow",
          scope: "project",
          paths: ["**"],
          reason: "Broad allow should be overridden by warn and deny.",
        },
        {
          id: "warn-claude-md",
          action: "warn",
          scope: "project",
          paths: ["CLAUDE.md"],
          changes: ["changed"],
          reason: "Warn on CLAUDE.md edits.",
        },
        {
          id: "deny-settings",
          action: "deny",
          scope: "project",
          paths: [".claude/settings.json"],
          reason: "Never allow settings changes even within thresholds.",
        },
      ],
    };

    const evaluation = evaluateDriftPolicy(report, policy);

    expect(evaluation.status).toBe("blocked");
    expect(evaluation.blocking).toBe(true);
    expect(evaluation.thresholdViolations).toEqual([]);
    expect(evaluation.summary).toEqual({
      allowed: 1,
      warned: 1,
      denied: 1,
      unmatched: 1,
      thresholdViolations: 0,
      blocking: 2,
      totalChanges: 4,
    });
    expect(
      evaluation.decisions.map((d) => [d.path, d.decision, d.blocking]),
    ).toEqual([
      [".claude/settings.json", "deny", true],
      ["CLAUDE.md", "warn", false],
      [".claude/rules/testing.md", "allow", false],
      ["config.toml", "unmatched", true],
    ]);
  });

  it("allows warn-only changes as non-blocking", () => {
    const report = makeReport(
      [
        {
          change: "changed",
          scope: "project",
          path: "AGENTS.md",
        },
      ],
      16,
    );
    const evaluation = evaluateDriftPolicy(report, {
      version: 1,
      maxBytesDelta: 64,
      rules: [
        {
          id: "warn-agents",
          action: "warn",
          scope: "project",
          paths: ["AGENTS.md"],
          changes: ["changed"],
          reason: "Review AGENTS.md updates.",
        },
      ],
    });

    expect(evaluation.status).toBe("warn");
    expect(evaluation.blocking).toBe(false);
    expect(evaluation.summary).toMatchObject({ warned: 1, blocking: 0 });
  });

  it("detects maxAdded, maxRemoved, maxChanged, and symmetric maxBytesDelta threshold violations", () => {
    const report = makeReport(
      [
        { change: "added", scope: "project", path: ".claude/rules/a.md" },
        { change: "added", scope: "project", path: ".claude/rules/b.md" },
        { change: "removed", scope: "project", path: ".claude/rules/old.md" },
        { change: "changed", scope: "project", path: "AGENTS.md" },
      ],
      -500,
    );

    const evaluation = evaluateDriftPolicy(report, {
      version: 1,
      maxAdded: 1,
      maxRemoved: 0,
      maxChanged: 0,
      maxBytesDelta: 250,
      rules: [
        {
          id: "allow-project",
          action: "allow",
          scope: "project",
          paths: ["**"],
          reason: "Allowed paths, but thresholds still enforce limits.",
        },
      ],
    });

    expect(evaluation.status).toBe("blocked");
    expect(evaluation.blocking).toBe(true);
    expect(evaluation.summary).toMatchObject({
      allowed: 4,
      thresholdViolations: 4,
      blocking: 4,
    });
    expect(evaluation.thresholdViolations).toEqual([
      { kind: "max-added", blocking: true, actual: 2, limit: 1 },
      { kind: "max-removed", blocking: true, actual: 1, limit: 0 },
      { kind: "max-changed", blocking: true, actual: 1, limit: 0 },
      {
        kind: "max-bytes-delta",
        blocking: true,
        actual: 500,
        limit: 250,
        signedDelta: -500,
      },
    ]);

    const rendered = renderDriftPolicyReport(
      report,
      evaluation,
      "ctxwise.drift.yaml",
    );
    expect(rendered).toContain("policy: blocked");
    expect(rendered).toContain("[ALLOW] project/.claude/rules/a.md");
    expect(rendered).toContain("Threshold violations:");
    expect(rendered).toContain("|-500| (500 bytes)");
    expect(rendered).toContain("Policy: ctxwise.drift.yaml");
  });

  it("renders non-blocking warn/unmatched decisions clearly", () => {
    const report = makeReport(
      [
        { change: "added", scope: "project", path: ".mcp.json" },
        { change: "removed", scope: "project", path: "AGENTS.md" },
        { change: "changed", scope: "codex-home", path: "config.toml" },
      ],
      40,
    );
    const evaluation = evaluateDriftPolicy(report, {
      version: 1,
      rules: [
        {
          id: "warn-config",
          action: "warn",
          scope: "codex-home",
          paths: ["config.toml"],
          reason: "Warn on config changes.",
        },
      ],
    });

    const rendered = renderDriftPolicyReport(report, evaluation);
    expect(rendered).toContain("+ [UNMATCHED] project/.mcp.json");
    expect(rendered).toContain("- [UNMATCHED] project/AGENTS.md");
    expect(rendered).toContain("~ [WARN] codex-home/config.toml (warn-config)");
  });

  it("rejects invalid programmatic policy objects", () => {
    expect(() =>
      evaluateDriftPolicy(makeReport([]), {
        version: 1,
        rules: [
          {
            id: "bad",
            action: "allow",
            paths: ["../escape.md"],
            reason: "bad",
          },
        ],
      }),
    ).toThrow(/traversal/i);
  });
});
