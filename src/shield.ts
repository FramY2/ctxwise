import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { expandHomePath } from "./mcp-xray.js";
import { CTXWISE_VERSION } from "./version.js";

export type ShieldRiskSeverity = "low" | "medium" | "high" | "critical";

export type ShieldCategory =
  | "secret-exposure"
  | "prompt-injection"
  | "hidden-unicode"
  | "unpinned-mcp-exec"
  | "config-hygiene";

export interface ShieldFinding {
  id: string;
  category: ShieldCategory;
  severity: ShieldRiskSeverity;
  path: string;
  line: number;
  message: string;
  snippet: string;
}

export interface ShieldReport {
  status: "secure" | "warning" | "vulnerable";
  scannedFiles: number;
  findings: ShieldFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export interface SarifRuleDescriptor {
  id: string;
  shortDescription: { text: string };
  defaultConfiguration: {
    level: "error" | "warning" | "note";
  };
  properties: {
    category: ShieldCategory;
    severity: ShieldRiskSeverity;
  };
}

export interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: {
        uri: string;
        uriBaseId: string;
      };
      region: {
        startLine: number;
        snippet: { text: string };
      };
    };
  }>;
  properties: {
    category: ShieldCategory;
    severity: ShieldRiskSeverity;
  };
}

export interface SarifLog {
  $schema: string;
  version: "2.1.0";
  runs: Array<{
    tool: {
      driver: {
        name: string;
        informationUri: string;
        version: string;
        rules: SarifRuleDescriptor[];
      };
    };
    results: SarifResult[];
  }>;
}

interface SecretRule {
  id: string;
  severity: ShieldRiskSeverity;
  pattern: RegExp;
  message: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: "anthropic-api-key",
    severity: "critical",
    pattern: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{20,}\b/,
    message: "Hardcoded Anthropic API key detected in agent context surface.",
  },
  {
    id: "openai-api-key",
    severity: "critical",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
    message: "Hardcoded OpenAI API key detected in agent context surface.",
  },
  {
    id: "github-pat-token",
    severity: "critical",
    pattern:
      /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    message:
      "Hardcoded GitHub personal access token detected in agent context surface.",
  },
  {
    id: "aws-access-key",
    severity: "critical",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    message: "AWS access key ID detected in agent context surface.",
  },
  {
    id: "private-key-block",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    message:
      "Private cryptographic key block detected in agent context surface.",
  },
  {
    id: "generic-env-secret",
    severity: "high",
    pattern:
      /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'/@]*:([^\s"'/@]{6,})@[^\s"']+|AccountKey=([A-Za-z0-9+/=]{16,})|(?:^|[\s{,;])(?:export\s+)?["']?(?:[A-Z0-9_]*(?:API_KEY|API_SECRET|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSPHRASE|_PWD|TOKEN|SECRET|ACCESS_KEY|_KEY))["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.@:$!%^&*~=-]{16,})["']?(?=\s*(?:#|\/\/)|[\s,;}\])]|\s*$)/i,
    message: "Plaintext credential assignment detected in agent configuration.",
  },
];

const INJECTION_RULES: SecretRule[] = [
  {
    id: "prompt-override-directive",
    severity: "high",
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|guardrails)\b/i,
    message:
      "Potential prompt-injection override directive detected in guidance or skill file.",
  },
  {
    id: "covert-html-comment-instruction",
    severity: "high",
    pattern:
      /<!--[\s\S]{0,400}?\b(?:system\s*prompt|ignore\s+previous|curl\s+https?:\/\/|wget\s+https?:\/\/|exfiltrate|send\s+to\s+https?:\/\/)[\s\S]{0,400}?-->/i,
    message:
      "Suspicious covert instruction or exfiltration URL inside HTML comment.",
  },
];

const HIDDEN_UNICODE_PATTERN =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

function maskSnippet(line: string): string {
  const trimmed = line.trim();
  const masked = trimmed
    .replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{10,}\b/g, "$1***REDACTED***")
    .replace(
      /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{4})[A-Za-z0-9]{10,}\b/g,
      "$1***REDACTED***",
    )
    .replace(
      /\b(github_pat_[A-Za-z0-9_]{6})[A-Za-z0-9_]{10,}\b/g,
      "$1***REDACTED***",
    )
    .replace(/\b((?:AKIA|ASIA)[0-9A-Z]{4})[0-9A-Z]{12}\b/g, "$1***REDACTED***")
    .replace(
      /(:\/\/[^\s"'/@]*:)([^\s"'/@]{2})[^\s"'/@]{4,}(@)/gi,
      "$1$2***REDACTED***$3",
    )
    .replace(
      /(AccountKey=)([A-Za-z0-9+/=]{4})[A-Za-z0-9+/=]{12,}/gi,
      "$1$2***REDACTED***",
    )
    .replace(
      /((?:^|[\s{,;])(?:export\s+)?["']?(?:[A-Z0-9_]*(?:API_KEY|API_SECRET|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSPHRASE|_PWD|TOKEN|SECRET|ACCESS_KEY|_KEY))["']?\s*[:=]\s*["']?)([A-Za-z0-9/+_.@:$!%^&*~=-]{4})[A-Za-z0-9/+_.@:$!%^&*~=-]{12,}(["']?)/gi,
      "$1$2***REDACTED***$3",
    );
  return masked.length > 140 ? `${masked.slice(0, 137)}...` : masked;
}

function isPlaceholderSecret(value: string): boolean {
  return /(?:\$\{[A-Z0-9_]+\}|\$[A-Z0-9_]+|\*\*\*REDACTED\*\*\*|YOUR[-_][A-Z0-9_-]+|(?:goes|put)[-_]here|changeme|example|placeholder|dummy|fake|test[_-]?key|<[^>]+>)/i.test(
    value,
  );
}

export function scanContentWithShield(
  content: string,
  displayPath: string,
): ShieldFinding[] {
  const findings: ShieldFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;

    if (
      HIDDEN_UNICODE_PATTERN.test(line) &&
      !(index === 0 && line.startsWith("\uFEFF"))
    ) {
      findings.push({
        id: "hidden-bidi-or-zero-width",
        category: "hidden-unicode",
        severity: "high",
        path: displayPath,
        line: lineNumber,
        message:
          "Hidden zero-width or bidirectional Unicode character detected (possible Trojan Source / covert prompt injection).",
        snippet: maskSnippet(
          line.replace(HIDDEN_UNICODE_PATTERN, "[HIDDEN_UNICODE]"),
        ),
      });
    }

    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (match) {
        const candidateValue = match[1] ?? match[2] ?? match[3] ?? match[0];
        if (
          rule.id !== "private-key-block" &&
          isPlaceholderSecret(candidateValue)
        ) {
          continue;
        }
        findings.push({
          id: rule.id,
          category: "secret-exposure",
          severity: rule.severity,
          path: displayPath,
          line: lineNumber,
          message: rule.message,
          snippet: maskSnippet(line),
        });
        break;
      }
    }

    for (const rule of INJECTION_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          id: rule.id,
          category: "prompt-injection",
          severity: rule.severity,
          path: displayPath,
          line: lineNumber,
          message: rule.message,
          snippet: maskSnippet(line),
        });
      }
    }
  }

  // Check multi-line covert HTML comments
  const multiLineCommentMatch =
    /<!--[\s\S]{0,600}?\b(?:ignore\s+all\s+previous|system\s+override|exfiltrate|curl\s+-s\s+https?:\/\/)[\s\S]{0,600}?-->/i.exec(
      content,
    );
  if (
    multiLineCommentMatch &&
    !findings.some((f) => f.id === "covert-html-comment-instruction")
  ) {
    const before = content.slice(0, multiLineCommentMatch.index);
    const lineNumber = before.split(/\r?\n/).length;
    findings.push({
      id: "covert-html-comment-instruction",
      category: "prompt-injection",
      severity: "high",
      path: displayPath,
      line: lineNumber,
      message:
        "Suspicious covert instruction or exfiltration payload inside multi-line HTML comment.",
      snippet: maskSnippet(multiLineCommentMatch[0].replace(/\s+/g, " ")),
    });
  }

  // Check Claude Code settings.json for misplaced "mcpServers" block (anthropics/claude-code#105885)
  const normalizedDisplayPath = displayPath.replaceAll("\\", "/");
  if (
    /(?:^|\/)(?:\.claude\/|claude-home\/(?:\.claude\/)?)?settings(?:\.local)?\.json$/i.test(
      normalizedDisplayPath,
    )
  ) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.mcpServers !== undefined &&
        parsed.mcpServers !== null &&
        typeof parsed.mcpServers === "object"
      ) {
        const lineIdx = lines.findIndex((l) => /"mcpServers"\s*:/.test(l));
        const lineNumber = lineIdx >= 0 ? lineIdx + 1 : 1;
        findings.push({
          id: "claude-settings-misplaced-mcp-servers",
          category: "config-hygiene",
          severity: "medium",
          path: displayPath,
          line: lineNumber,
          message:
            '"mcpServers" inside Claude settings.json is rejected by Claude Code schema validation (causing +141k-token update-config retry loops); move MCP servers to .mcp.json or ~/.claude.json.',
          snippet: maskSnippet(lines[lineNumber - 1] ?? '"mcpServers": {}'),
        });
      }
    } catch {
      // Ignore malformed JSON here
    }
  }

  return findings;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkContextFiles(root: string, depth = 5): Promise<string[]> {
  if (depth < 0 || !(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (
      [
        ".git",
        "node_modules",
        "dist",
        "coverage",
        ".next",
        "target",
        "build",
      ].includes(entry.name)
    ) {
      continue;
    }
    const fullPath = join(root, entry.name);
    if (entry.isFile()) {
      const normalized = fullPath.replaceAll("\\", "/");
      const isAgentFile =
        /\/(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI|SKILL)\.md$/i.test(
          normalized,
        ) ||
        normalized.endsWith("/.cursorrules") ||
        normalized.endsWith("/.mcp.json") ||
        normalized.includes("/.codex/") ||
        normalized.includes("/.claude/") ||
        normalized.includes("/.cursor/rules/") ||
        normalized.includes("/.agents/skills/") ||
        normalized.endsWith("/copilot-instructions.md");
      if (isAgentFile) files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...(await walkContextFiles(fullPath, depth - 1)));
    }
  }
  return files;
}

export async function runContextShield(options: {
  projectRoot: string;
  claudeHome?: string;
}): Promise<ShieldReport> {
  const root = resolve(options.projectRoot);
  const candidateFiles = (await walkContextFiles(root, 5)).sort();
  const findings: ShieldFinding[] = [];
  let scannedCount = candidateFiles.length;

  for (const filePath of candidateFiles) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    if (!content) continue;
    const relPath = relative(root, filePath).replaceAll("\\", "/");
    findings.push(...scanContentWithShield(content, relPath));
  }

  if (options.claudeHome) {
    const cHome = expandHomePath(options.claudeHome);
    const homeSettingsCandidates = [join(cHome, "settings.json")];
    if (basename(cHome) !== ".claude") {
      homeSettingsCandidates.push(join(cHome, ".claude", "settings.json"));
    }
    for (const settingsPath of homeSettingsCandidates) {
      if (candidateFiles.includes(settingsPath)) continue;
      if (!(await exists(settingsPath))) continue;
      const content = await readFile(settingsPath, "utf8").catch(() => "");
      if (!content) continue;
      scannedCount += 1;
      const rel = relative(cHome, settingsPath).replaceAll("\\", "/");
      findings.push(...scanContentWithShield(content, `claude-home/${rel}`));
      break;
    }
  }

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    total: findings.length,
  };

  const status: ShieldReport["status"] =
    summary.critical > 0 || summary.high > 0
      ? "vulnerable"
      : summary.medium > 0 || summary.low > 0
        ? "warning"
        : "secure";

  return {
    status,
    scannedFiles: scannedCount,
    findings,
    summary,
  };
}

function severityToSarifLevel(
  severity: ShieldRiskSeverity,
): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

export function buildShieldSarif(
  report: ShieldReport,
  version = CTXWISE_VERSION,
): SarifLog {
  const catalogRules: Array<{
    id: string;
    category: ShieldCategory;
    severity: ShieldRiskSeverity;
    message: string;
  }> = [
    ...SECRET_RULES.map((r) => ({
      id: r.id,
      category: "secret-exposure" as const,
      severity: r.severity,
      message: r.message,
    })),
    ...INJECTION_RULES.map((r) => ({
      id: r.id,
      category: "prompt-injection" as const,
      severity: r.severity,
      message: r.message,
    })),
    {
      id: "hidden-bidi-or-zero-width",
      category: "hidden-unicode",
      severity: "high",
      message:
        "Hidden zero-width or bidirectional Unicode character detected (possible Trojan Source / covert prompt injection).",
    },
    {
      id: "claude-settings-misplaced-mcp-servers",
      category: "config-hygiene",
      severity: "medium",
      message:
        '"mcpServers" inside Claude settings.json is rejected by Claude Code schema validation; move MCP servers to .mcp.json or ~/.claude.json.',
    },
  ];

  const knownRuleIds = new Set(catalogRules.map((r) => r.id));
  for (const finding of report.findings) {
    if (!knownRuleIds.has(finding.id)) {
      knownRuleIds.add(finding.id);
      catalogRules.push({
        id: finding.id,
        category: finding.category,
        severity: finding.severity,
        message: finding.message,
      });
    }
  }

  const rules: SarifRuleDescriptor[] = catalogRules.map((rule) => ({
    id: rule.id,
    shortDescription: { text: rule.message },
    defaultConfiguration: {
      level: severityToSarifLevel(rule.severity),
    },
    properties: {
      category: rule.category,
      severity: rule.severity,
    },
  }));

  const results: SarifResult[] = report.findings.map((finding) => ({
    ruleId: finding.id,
    level: severityToSarifLevel(finding.severity),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: {
            uri: finding.path.replaceAll("\\", "/"),
            uriBaseId: "%SRCROOT%",
          },
          region: {
            startLine: Math.max(1, finding.line),
            snippet: { text: finding.snippet },
          },
        },
      },
    ],
    properties: {
      category: finding.category,
      severity: finding.severity,
    },
  }));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "CtxWise Shield",
            informationUri: "https://github.com/FramY2/ctxwise",
            version,
            rules,
          },
        },
        results,
      },
    ],
  };
}

export function renderShieldReport(report: ShieldReport): string {
  const lines = [
    `CtxWise shield · ${report.status} · ${report.scannedFiles} context files scanned · ${report.summary.total} findings`,
  ];
  if (report.findings.length === 0) {
    lines.push(
      "- No hardcoded API keys, prompt-injection directives, or hidden Unicode payloads detected in active agent context files.",
    );
  } else {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.path}:${finding.line} (${finding.id}) — ${finding.message}`,
        `  snippet: ${finding.snippet}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
