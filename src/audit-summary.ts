import type { AuditReport } from "./audit.js";

export interface AuditContributor {
  kind: "guidance" | "source" | "skill-discovery";
  label: string;
  path: string;
  estimatedTokens: number;
}

export interface AuditSnapshot {
  provenance: "estimated";
  status: "clean" | "attention" | "error";
  estimatedKnownStartupTokens: number;
  guidanceFiles: number;
  skills: number;
  plugins: number;
  mcpServers: number;
  unmeasuredConfigSources: number;
  topContributors: AuditContributor[];
  recommendations: string[];
}

function recommendationList(report: AuditReport): string[] {
  const codes = new Set(report.findings.map((finding) => finding.code));
  const recommendations: string[] = [];
  const errors = report.findings.filter(
    (finding) => finding.severity === "error",
  ).length;

  if (errors > 0) {
    recommendations.push(
      `Fix ${errors} audit ${errors === 1 ? "error" : "errors"} before relying on this context surface.`,
    );
  }
  if (codes.has("skill-catalog-budget")) {
    recommendations.push(
      "Review unused skills or plugins, disable what you do not need, then run this snapshot again.",
    );
  }
  if (
    codes.has("duplicate-skill-name") ||
    codes.has("duplicate-skill-description")
  ) {
    recommendations.push(
      "Resolve duplicate skill names or descriptions so Codex discovery stays unambiguous.",
    );
  }
  if (codes.has("unmeasured-mcp-schemas")) {
    recommendations.push(
      "Use prompt X-Ray before an important turn to include model-visible surfaces that static MCP inventory cannot measure.",
    );
  }

  return recommendations;
}

export function buildAuditSnapshot(
  report: AuditReport,
  options: { top: number },
): AuditSnapshot {
  const sourceContributors: AuditContributor[] = report.sources
    .filter(
      (source): source is typeof source & { estimatedTokens: number } =>
        source.estimatedTokens !== null && source.estimatedTokens > 0,
    )
    .map((source) => ({
      kind:
        source.kind === "agents-guidance"
          ? ("guidance" as const)
          : ("source" as const),
      label: source.path,
      path: source.path,
      estimatedTokens: source.estimatedTokens,
    }));
  const skillContributors: AuditContributor[] = report.skills
    .filter((skill) => skill.estimatedDiscoveryTokens > 0)
    .map((skill) => ({
      kind: "skill-discovery" as const,
      label: skill.name,
      path: skill.path,
      estimatedTokens: skill.estimatedDiscoveryTokens,
    }));
  const top = Math.max(1, Math.min(20, options.top));
  const topContributors = [...sourceContributors, ...skillContributors]
    .sort(
      (left, right) =>
        right.estimatedTokens - left.estimatedTokens ||
        left.label.localeCompare(right.label),
    )
    .slice(0, top);
  const hasErrors = report.findings.some(
    (finding) => finding.severity === "error",
  );
  const hasWarnings = report.findings.some(
    (finding) => finding.severity === "warning",
  );

  return {
    provenance: "estimated",
    status: hasErrors ? "error" : hasWarnings ? "attention" : "clean",
    estimatedKnownStartupTokens: report.estimatedKnownStartupTokens,
    guidanceFiles: report.sources.filter(
      (source) => source.kind === "agents-guidance",
    ).length,
    skills: report.skills.length,
    plugins: report.plugins.length,
    mcpServers: report.mcpServers.length,
    unmeasuredConfigSources: report.sources.filter(
      (source) =>
        source.contextRole === "configuration" &&
        source.estimatedTokens === null,
    ).length,
    topContributors,
    recommendations: recommendationList(report),
  };
}

function countLabel(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

function contributorKind(kind: AuditContributor["kind"]): string {
  return kind === "skill-discovery" ? "skill discovery" : kind;
}

export function renderAuditSnapshot(snapshot: AuditSnapshot): string {
  const lines = [
    `CtxWise snapshot · ${snapshot.status} · ~${snapshot.estimatedKnownStartupTokens.toLocaleString("en-US")} known startup tokens (estimated)`,
    `${countLabel(snapshot.guidanceFiles, "guidance file", "guidance files")} · ${countLabel(snapshot.skills, "skill description", "skill descriptions")} · ${countLabel(snapshot.plugins, "plugin", "plugins")} · ${countLabel(snapshot.mcpServers, "MCP server", "MCP servers")}`,
  ];

  if (snapshot.topContributors.length > 0) {
    lines.push("", "Largest known contributors:");
    for (const contributor of snapshot.topContributors) {
      lines.push(
        `- ~${contributor.estimatedTokens.toLocaleString("en-US")} · ${contributorKind(contributor.kind)} · ${contributor.label}`,
      );
    }
  }

  if (snapshot.unmeasuredConfigSources > 0 || snapshot.mcpServers > 0) {
    lines.push(
      "",
      `${countLabel(snapshot.unmeasuredConfigSources, "config/profile source", "config/profile sources")} and ${countLabel(snapshot.mcpServers, "MCP tool-schema surface", "MCP tool-schema surfaces")} are unmeasured; unknown is not treated as zero.`,
    );
  }

  if (snapshot.recommendations.length > 0) {
    lines.push("", "Next actions:");
    for (const recommendation of snapshot.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
