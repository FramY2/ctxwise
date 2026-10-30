import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  guidanceCandidateFilenames,
  guidanceConfigFromRecords,
} from "./guidance.js";

export interface CodexGuidanceChainEntry {
  scope: "codex-home" | "project";
  path: string;
  rawBytes: number;
  includedBytes: number;
  estimatedTokens: number;
  truncated: boolean;
  shadowedPaths: string[];
}

export interface CodexDoctorFinding {
  code:
    | "invalid-config-toml"
    | "empty-override-shadows-agents"
    | "empty-global-override"
    | "guidance-truncated"
    | "approaching-max-bytes"
    | "override-active";
  severity: "info" | "warning" | "error";
  message: string;
  path: string;
}

export interface CodexDoctorReport {
  provenance: "estimated";
  status: "healthy" | "warning" | "truncated" | "error";
  maxBytes: number;
  fallbackFilenames: string[];
  totalRawBytes: number;
  totalIncludedBytes: number;
  remainingBytes: number;
  utilizationPercent: number;
  estimatedTokens: number;
  truncated: boolean;
  chain: CodexGuidanceChainEntry[];
  findings: CodexDoctorFinding[];
  recommendations: string[];
}

export interface CodexDoctorOptions {
  codexHome: string;
  projectRoot: string;
  workingDirectory?: string;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function scopedDisplayPath(
  fullPath: string,
  root: string,
  scope: "codex-home" | "project",
): string {
  return `${scope}/${portablePath(relative(root, fullPath))}`;
}

function isWithin(root: string, candidate: string): boolean {
  const scoped = relative(root, candidate);
  return (
    scoped === "" ||
    (scoped !== ".." &&
      !scoped.startsWith(`..\\`) &&
      !scoped.startsWith("../") &&
      !isAbsolute(scoped))
  );
}

function directoryChain(
  projectRoot: string,
  workingDirectory: string,
): string[] {
  const root = resolve(projectRoot);
  const cwd = resolve(workingDirectory);
  if (!isWithin(root, cwd)) return [root];
  const scoped = relative(root, cwd);
  if (!scoped) return [root];
  const directories = [root];
  let current = root;
  for (const segment of scoped.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    directories.push(current);
  }
  return directories;
}

export async function runCodexDoctor(
  options: CodexDoctorOptions,
): Promise<CodexDoctorReport> {
  const codexHome = resolve(options.codexHome);
  const projectRoot = resolve(options.projectRoot);
  const workingDirectory = resolve(
    options.workingDirectory ?? options.projectRoot,
  );

  const findings: CodexDoctorFinding[] = [];
  const chain: CodexGuidanceChainEntry[] = [];

  let userConfig: Record<string, unknown> = {};
  const userConfigPath = join(codexHome, "config.toml");
  if (await isFile(userConfigPath)) {
    try {
      const parsed = parseToml(await readFile(userConfigPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        userConfig = parsed as Record<string, unknown>;
      }
    } catch {
      findings.push({
        code: "invalid-config-toml",
        severity: "error",
        message:
          "Codex user config (codex-home/config.toml) is not valid TOML.",
        path: "codex-home/config.toml",
      });
    }
  }

  let projectConfig: Record<string, unknown> = {};
  const projectConfigPath = join(projectRoot, ".codex", "config.toml");
  if (await isFile(projectConfigPath)) {
    try {
      const parsed = parseToml(await readFile(projectConfigPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        projectConfig = parsed as Record<string, unknown>;
      }
    } catch {
      findings.push({
        code: "invalid-config-toml",
        severity: "error",
        message:
          "Codex project config (project/.codex/config.toml) is not valid TOML.",
        path: "project/.codex/config.toml",
      });
    }
  }

  const config = guidanceConfigFromRecords([userConfig, projectConfig]);
  const maxBytes = config.maxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES;

  // 1. Inspect global guidance in CODEX_HOME
  const globalOverridePath = join(codexHome, "AGENTS.override.md");
  const globalAgentsPath = join(codexHome, "AGENTS.md");
  const hasGlobalOverride = await isFile(globalOverridePath);
  const hasGlobalAgents = await isFile(globalAgentsPath);

  if (hasGlobalOverride) {
    const raw = await readFile(globalOverridePath, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) {
      findings.push({
        code: "empty-global-override",
        severity: "warning",
        message: hasGlobalAgents
          ? "codex-home/AGENTS.override.md is empty; Codex falls back to codex-home/AGENTS.md."
          : "codex-home/AGENTS.override.md is empty and contributes no global instructions.",
        path: "codex-home/AGENTS.override.md",
      });
      if (hasGlobalAgents) {
        const fallbackRaw = (await readFile(globalAgentsPath, "utf8")).trim();
        if (fallbackRaw) {
          const bytes = Buffer.byteLength(fallbackRaw);
          chain.push({
            scope: "codex-home",
            path: "codex-home/AGENTS.md",
            rawBytes: bytes,
            includedBytes: bytes,
            estimatedTokens: Math.ceil(fallbackRaw.length / 4),
            truncated: false,
            shadowedPaths: [],
          });
        }
      }
    } else {
      const bytes = Buffer.byteLength(trimmed);
      const shadowed = hasGlobalAgents ? ["codex-home/AGENTS.md"] : [];
      chain.push({
        scope: "codex-home",
        path: "codex-home/AGENTS.override.md",
        rawBytes: bytes,
        includedBytes: bytes,
        estimatedTokens: Math.ceil(trimmed.length / 4),
        truncated: false,
        shadowedPaths: shadowed,
      });
    }
  } else if (hasGlobalAgents) {
    const raw = (await readFile(globalAgentsPath, "utf8")).trim();
    if (raw) {
      const bytes = Buffer.byteLength(raw);
      chain.push({
        scope: "codex-home",
        path: "codex-home/AGENTS.md",
        rawBytes: bytes,
        includedBytes: bytes,
        estimatedTokens: Math.ceil(raw.length / 4),
        truncated: false,
        shadowedPaths: [],
      });
    }
  }

  // 2. Inspect project guidance hierarchy from projectRoot -> workingDirectory
  const candidateNames = guidanceCandidateFilenames(config.fallbackFilenames);
  let remaining = maxBytes;
  let totalRawBytes = 0;
  let totalIncludedBytes = 0;
  let anyTruncated = false;

  for (const directory of directoryChain(projectRoot, workingDirectory)) {
    const existingCandidates: string[] = [];
    for (const name of candidateNames) {
      const candidate = join(directory, name);
      if (await isFile(candidate)) {
        existingCandidates.push(candidate);
      }
    }
    if (existingCandidates.length === 0) continue;

    const selectedPath = existingCandidates[0]!;
    const shadowedPaths = existingCandidates
      .slice(1)
      .map((p) => scopedDisplayPath(p, projectRoot, "project"));
    const displayPath = scopedDisplayPath(selectedPath, projectRoot, "project");
    const data = await readFile(selectedPath);
    const rawText = data.toString("utf8");

    if (!rawText.trim()) {
      if (shadowedPaths.length > 0) {
        findings.push({
          code: "empty-override-shadows-agents",
          severity: "warning",
          message: `Empty ${displayPath} shadows ${shadowedPaths.join(", ")} in ${portablePath(relative(projectRoot, dirname(selectedPath)) || ".")}; no guidance from this directory will be loaded.`,
          path: displayPath,
        });
      }
      continue;
    }

    if (
      selectedPath.endsWith("AGENTS.override.md") &&
      shadowedPaths.length > 0
    ) {
      findings.push({
        code: "override-active",
        severity: "info",
        message: `${displayPath} is active and overrides ${shadowedPaths.join(", ")}.`,
        path: displayPath,
      });
    }

    const rawBytes = data.length;
    const includedBytes = Math.min(rawBytes, remaining);
    const truncated = includedBytes < rawBytes;
    const selectedText = data.subarray(0, includedBytes).toString("utf8");
    remaining = Math.max(0, remaining - includedBytes);

    totalRawBytes += rawBytes;
    totalIncludedBytes += includedBytes;
    if (truncated) {
      anyTruncated = true;
      findings.push({
        code: "guidance-truncated",
        severity: "warning",
        message:
          includedBytes === 0
            ? `${displayPath} (${rawBytes.toLocaleString("en-US")} bytes) is completely omitted because project_doc_max_bytes (${maxBytes.toLocaleString("en-US")} bytes) was already exhausted.`
            : `${displayPath} is truncated at ${includedBytes.toLocaleString("en-US")} of ${rawBytes.toLocaleString("en-US")} bytes (${(rawBytes - includedBytes).toLocaleString("en-US")} bytes dropped due to project_doc_max_bytes = ${maxBytes.toLocaleString("en-US")}).`,
        path: displayPath,
      });
    }

    chain.push({
      scope: "project",
      path: displayPath,
      rawBytes,
      includedBytes,
      estimatedTokens: Math.ceil(selectedText.length / 4),
      truncated,
      shadowedPaths,
    });
  }

  const utilizationPercent =
    maxBytes > 0
      ? Number(((totalRawBytes / maxBytes) * 100).toFixed(1))
      : totalRawBytes > 0
        ? 100
        : 0;

  if (!anyTruncated && maxBytes > 0 && totalRawBytes >= maxBytes * 0.85) {
    findings.push({
      code: "approaching-max-bytes",
      severity: "warning",
      message: `Project guidance chain uses ${totalRawBytes.toLocaleString("en-US")} of ${maxBytes.toLocaleString("en-US")} bytes (${utilizationPercent}%), approaching the Codex truncation limit.`,
      path: "project/AGENTS.md",
    });
  }

  const recommendations: string[] = [];
  if (anyTruncated) {
    recommendations.push(
      "Run `ctxwise sync --compress` to strip boilerplate comments and duplicate bullets, or raise `project_doc_max_bytes` in `.codex/config.toml`.",
    );
  }
  if (findings.some((f) => f.code === "empty-override-shadows-agents")) {
    recommendations.push(
      "Remove empty `AGENTS.override.md` files so Codex can load `AGENTS.md` in those directories.",
    );
  }
  if (findings.some((f) => f.code === "invalid-config-toml")) {
    recommendations.push(
      "Fix syntax errors in `config.toml` so Codex can parse `project_doc_max_bytes` and MCP server settings.",
    );
  }

  const hasError = findings.some((f) => f.severity === "error");
  const hasWarning = findings.some((f) => f.severity === "warning");
  const status: CodexDoctorReport["status"] = hasError
    ? "error"
    : anyTruncated
      ? "truncated"
      : hasWarning
        ? "warning"
        : "healthy";

  const estimatedTokens = chain.reduce(
    (sum, item) => sum + item.estimatedTokens,
    0,
  );

  return {
    provenance: "estimated",
    status,
    maxBytes,
    fallbackFilenames: config.fallbackFilenames,
    totalRawBytes,
    totalIncludedBytes,
    remainingBytes: remaining,
    utilizationPercent,
    estimatedTokens,
    truncated: anyTruncated,
    chain,
    findings,
    recommendations,
  };
}

export function renderCodexDoctorReport(report: CodexDoctorReport): string {
  const lines = [
    `CtxWise codex-doctor · ${report.status} · ${report.totalIncludedBytes.toLocaleString("en-US")} / ${report.maxBytes.toLocaleString("en-US")} bytes (${report.utilizationPercent}%) · ~${report.estimatedTokens.toLocaleString("en-US")} tokens`,
  ];

  if (report.chain.length > 0) {
    lines.push("", "Active guidance chain:");
    for (const entry of report.chain) {
      const badge = entry.truncated ? " [TRUNCATED]" : "";
      const shadowed =
        entry.shadowedPaths.length > 0
          ? ` (shadows ${entry.shadowedPaths.join(", ")})`
          : "";
      lines.push(
        `- ${entry.path}: ${entry.includedBytes.toLocaleString("en-US")}/${entry.rawBytes.toLocaleString("en-US")} bytes (~${entry.estimatedTokens.toLocaleString("en-US")} tokens)${badge}${shadowed}`,
      );
    }
  } else {
    lines.push("", "No active AGENTS.md or AGENTS.override.md guidance found.");
  }

  if (report.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.message}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
