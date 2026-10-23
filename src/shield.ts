import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export type ShieldRiskSeverity = "low" | "medium" | "high" | "critical";

export type ShieldCategory =
  | "secret-exposure"
  | "prompt-injection"
  | "hidden-unicode"
  | "unpinned-mcp-exec";

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
      /(?:^|[\s{,;])(?:export\s+)?["']?(?:[A-Z0-9_]*(?:API_KEY|API_SECRET|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSPHRASE|PWD|TOKEN|SECRET|ACCESS_KEY|_KEY|DATABASE_URL|_DSN|_DSN_URL))["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.@:$!%^&*~=-]{16,})["']?(?=\s*(?:#|\/\/)|[\s,;}\])]|\s*$)/i,
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
      /((?:^|[\s{,;])(?:export\s+)?["']?(?:[A-Z0-9_]*(?:API_KEY|API_SECRET|SECRET_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|PASSPHRASE|PWD|TOKEN|SECRET|ACCESS_KEY|_KEY|DATABASE_URL|_DSN|_DSN_URL))["']?\s*[:=]\s*["']?)([A-Za-z0-9/+_.@:$!%^&*~=-]{4})[A-Za-z0-9/+_.@:$!%^&*~=-]{12,}(["']?)/gi,
      "$1$2***REDACTED***$3",
    );
  return masked.length > 100 ? `${masked.slice(0, 97)}...` : masked;
}

function isPlaceholderSecret(value: string): boolean {
  return /(?:\$\{[A-Z0-9_]+\}|\$[A-Z0-9_]+|\*\*\*REDACTED\*\*\*|YOUR_[A-Z0-9_]+|example|placeholder|dummy|fake|test[_-]?key|<[^>]+>)/i.test(
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
        const candidateValue = match[1] ?? match[0];
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
}): Promise<ShieldReport> {
  const root = resolve(options.projectRoot);
  const candidateFiles = (await walkContextFiles(root, 5)).sort();
  const findings: ShieldFinding[] = [];

  for (const filePath of candidateFiles) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    if (!content) continue;
    const relPath = relative(root, filePath).replaceAll("\\", "/");
    findings.push(...scanContentWithShield(content, relPath));
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
    scannedFiles: candidateFiles.length,
    findings,
    summary,
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
