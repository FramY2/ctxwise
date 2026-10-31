import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_BYTE_CAP = 32_768;
export const DEFAULT_TOKENS_PER_MCP_SERVER = 1_200;

export const WATCHED_RELATIVE_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "AGENTS.override.md",
  ".cursorrules",
  ".mcp.json",
  ".codex/config.toml",
  ".claude/settings.json",
] as const;

export type ContextGrade = "A" | "B" | "C" | "D" | "F";

export interface FileBreakdownEntry {
  relativePath: string;
  bytes: number;
  estimatedTokens: number;
  secretCount: number;
}

export interface WorkspaceContextSummary {
  workspaceRoot: string;
  files: FileBreakdownEntry[];
  instructionTokens: number;
  mcpServerCount: number;
  mcpServerNames: string[];
  estimatedMcpTokens: number;
  totalEstimatedTokens: number;
  codexInstructionBytes: number;
  codexByteCapPercent: number;
  secretCount: number;
  misplacedMcpInSettings: boolean;
  grade: ContextGrade;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-(?!ant-)(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{24,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{24,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^/\s:@]+:[^/\s@]+@[^\s"']+/gi,
];

function isPlaceholderMatch(matchText: string, lineText: string): boolean {
  const lowerMatch = matchText.toLowerCase();
  const lowerLine = lineText.toLowerCase();
  if (
    lowerMatch.includes("example") ||
    lowerMatch.includes("placeholder") ||
    lowerMatch.includes("redacted") ||
    lowerMatch.includes("your_") ||
    lowerMatch.includes("xxxx") ||
    lowerMatch.includes("000000") ||
    /^\$\{[a-z0-9_]+\}$/i.test(matchText)
  ) {
    return true;
  }
  if (
    lowerLine.includes("<your") ||
    lowerLine.includes("your_api_key") ||
    lowerLine.includes("replace_me") ||
    lowerLine.includes("example_key")
  ) {
    return true;
  }
  if (matchText.includes("://")) {
    const credMatch = /:\/\/([^/\s:@]+):([^/\s@]+)@/.exec(matchText);
    if (credMatch) {
      const pass = (credMatch[2] ?? "").toLowerCase();
      if (
        pass === "pass" ||
        pass === "password" ||
        pass === "secret" ||
        pass === "changeme" ||
        pass === "postgres" ||
        pass === "root" ||
        pass.startsWith("$") ||
        pass.startsWith("<")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function countSecretsInContent(content: string): number {
  let count = 0;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    for (const pattern of SECRET_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null = regex.exec(line);
      while (match !== null) {
        if (!isPlaceholderMatch(match[0], line)) {
          count += 1;
        }
        match = regex.exec(line);
      }
    }
  }
  return count;
}

export function parseMcpServersFromJson(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const servers = parsed["mcpServers"];
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return Object.keys(servers as Record<string, unknown>).filter((name) => {
        const entry = (servers as Record<string, unknown>)[name];
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const rec = entry as Record<string, unknown>;
          return rec["disabled"] !== true && rec["enabled"] !== false;
        }
        return true;
      });
    }
  } catch {
    // Ignore malformed JSON while user is editing
  }
  return [];
}

export function parseMcpServersFromToml(content: string): string[] {
  const names = new Set<string>();
  const lines = content.split(/\r?\n/);
  const headerRegex =
    /^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/;
  const anySectionRegex = /^\s*\[.*\]\s*(?:#.*)?$/;

  let currentServer: string | undefined;
  let currentDisabled = false;

  const commitCurrent = (): void => {
    if (currentServer) {
      if (!currentDisabled) {
        names.add(currentServer);
      } else {
        names.delete(currentServer);
      }
    }
  };

  for (const line of lines) {
    const headerMatch = headerRegex.exec(line);
    if (headerMatch) {
      commitCurrent();
      currentServer = headerMatch[1] ?? headerMatch[2] ?? headerMatch[3];
      currentDisabled = false;
      continue;
    }
    if (anySectionRegex.test(line)) {
      commitCurrent();
      currentServer = undefined;
      currentDisabled = false;
      continue;
    }
    if (currentServer) {
      const stripped = line.replace(/#.*$/, "").trim();
      if (
        /^enabled\s*=\s*false$/i.test(stripped) ||
        /^disabled\s*=\s*true$/i.test(stripped)
      ) {
        currentDisabled = true;
      }
    }
  }
  commitCurrent();

  return [...names];
}

export function computeContextGrade(input: {
  totalEstimatedTokens: number;
  codexByteCapPercent: number;
  secretCount: number;
  misplacedMcpInSettings: boolean;
}): ContextGrade {
  if (input.secretCount > 0 || input.codexByteCapPercent > 100) {
    return "F";
  }
  if (
    input.misplacedMcpInSettings ||
    input.totalEstimatedTokens > 15_000 ||
    input.codexByteCapPercent > 85
  ) {
    return "D";
  }
  if (input.totalEstimatedTokens > 8_000 || input.codexByteCapPercent > 65) {
    return "C";
  }
  if (input.totalEstimatedTokens > 3_500 || input.codexByteCapPercent > 40) {
    return "B";
  }
  return "A";
}

export function formatCompactTokens(tokens: number): string {
  if (tokens < 1_000) {
    return `${tokens}`;
  }
  const k = tokens / 1_000;
  return `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

export function analyzeWorkspaceContext(
  workspaceRoot: string,
): WorkspaceContextSummary {
  const files: FileBreakdownEntry[] = [];
  let instructionTokens = 0;
  let codexInstructionBytes = 0;
  let secretCount = 0;
  let misplacedMcpInSettings = false;
  const mcpServerNamesSet = new Set<string>();

  for (const relPath of WATCHED_RELATIVE_FILES) {
    const absPath = join(workspaceRoot, relPath);
    if (!existsSync(absPath)) {
      continue;
    }
    let content = "";
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const bytes = Buffer.byteLength(content, "utf8");
    const fileSecrets = countSecretsInContent(content);
    secretCount += fileSecrets;

    if (relPath === ".mcp.json") {
      for (const name of parseMcpServersFromJson(content)) {
        mcpServerNamesSet.add(name);
      }
      files.push({
        relativePath: relPath,
        bytes,
        estimatedTokens: Math.ceil(bytes / 4),
        secretCount: fileSecrets,
      });
      continue;
    }

    if (relPath === ".codex/config.toml") {
      for (const name of parseMcpServersFromToml(content)) {
        mcpServerNamesSet.add(name);
      }
      files.push({
        relativePath: relPath,
        bytes,
        estimatedTokens: Math.ceil(bytes / 4),
        secretCount: fileSecrets,
      });
      continue;
    }

    if (relPath === ".claude/settings.json") {
      try {
        const parsed = JSON.parse(content) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          "mcpServers" in parsed
        ) {
          misplacedMcpInSettings = true;
        }
      } catch {
        // Ignore parse error while typing
      }
      files.push({
        relativePath: relPath,
        bytes,
        estimatedTokens: Math.ceil(bytes / 4),
        secretCount: fileSecrets,
      });
      continue;
    }

    const estimatedTokens = Math.ceil(bytes / 4);
    instructionTokens += estimatedTokens;
    if (relPath === "AGENTS.md" || relPath === "AGENTS.override.md") {
      codexInstructionBytes += bytes;
    }

    files.push({
      relativePath: relPath,
      bytes,
      estimatedTokens,
      secretCount: fileSecrets,
    });
  }

  const mcpServerNames = [...mcpServerNamesSet].sort();
  const mcpServerCount = mcpServerNames.length;
  const estimatedMcpTokens = mcpServerCount * DEFAULT_TOKENS_PER_MCP_SERVER;
  const totalEstimatedTokens = instructionTokens + estimatedMcpTokens;
  const codexByteCapPercent = Number(
    ((codexInstructionBytes / CODEX_BYTE_CAP) * 100).toFixed(1),
  );

  const grade = computeContextGrade({
    totalEstimatedTokens,
    codexByteCapPercent,
    secretCount,
    misplacedMcpInSettings,
  });

  return {
    workspaceRoot,
    files,
    instructionTokens,
    mcpServerCount,
    mcpServerNames,
    estimatedMcpTokens,
    totalEstimatedTokens,
    codexInstructionBytes,
    codexByteCapPercent,
    secretCount,
    misplacedMcpInSettings,
    grade,
  };
}

export function formatStatusBarText(summary: WorkspaceContextSummary): string {
  const icon =
    summary.secretCount > 0 || summary.grade === "F"
      ? "$(warning)"
      : "$(shield)";
  const tokLabel = formatCompactTokens(summary.totalEstimatedTokens);
  const secretLabel =
    summary.secretCount === 1 ? "1 secret" : `${summary.secretCount} secrets`;
  return `${icon} CtxWise: ${tokLabel} tok · Grade ${summary.grade} · ${secretLabel}`;
}

export function formatStatusBarTooltip(
  summary: WorkspaceContextSummary,
): string {
  const lines: string[] = [];
  lines.push(`### 🛡️ CtxWise Context Firewall — Grade **${summary.grade}**`);
  lines.push("");
  lines.push(
    `- **Startup Token Tax:** \`~${summary.totalEstimatedTokens.toLocaleString("en-US")} tok/turn\` (\`${summary.instructionTokens.toLocaleString("en-US")}\` instruction + \`~${summary.estimatedMcpTokens.toLocaleString("en-US")}\` MCP schema est.)`,
  );
  lines.push(
    `- **Codex 32 KiB Cap:** \`${summary.codexInstructionBytes.toLocaleString("en-US")} / ${CODEX_BYTE_CAP.toLocaleString("en-US")} B (${summary.codexByteCapPercent}%)\``,
  );
  lines.push(
    `- **Active MCP Servers (${summary.mcpServerCount}):** ${
      summary.mcpServerNames.length > 0
        ? summary.mcpServerNames.map((n) => `\`${n}\``).join(", ")
        : "_none_"
    }`,
  );
  lines.push(
    `- **Security Shield:** ${
      summary.secretCount === 0
        ? "✅ `0` leaked secrets detected"
        : `🚨 **${summary.secretCount} exposed secret(s) detected!**`
    }`,
  );
  if (summary.misplacedMcpInSettings) {
    lines.push(
      `- ⚠️ **Claude Settings Hygiene:** \`"mcpServers"\` found in \`.claude/settings.json\` (move to \`.mcp.json\` to avoid \`#105885\` +141k retry loop)`,
    );
  }

  if (summary.files.length > 0) {
    lines.push("");
    lines.push("| File | Tokens | Bytes | Secrets |");
    lines.push("| :--- | ---: | ---: | ---: |");
    for (const file of summary.files) {
      lines.push(
        `| \`${file.relativePath}\` | ~${file.estimatedTokens.toLocaleString("en-US")} | ${file.bytes.toLocaleString("en-US")} B | ${file.secretCount} |`,
      );
    }
  } else {
    lines.push("");
    lines.push(
      "_No `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or `.mcp.json` found in workspace root._",
    );
  }

  lines.push("");
  lines.push(
    "[$(pulse) Run Full Audit](command:ctxwise.runFullAudit) · [$(shield) Scan Secrets (Shield)](command:ctxwise.scanSecrets) · [$(search) Inspect MCP Token Tax](command:ctxwise.inspectMcpTax)",
  );

  return lines.join("\n");
}
