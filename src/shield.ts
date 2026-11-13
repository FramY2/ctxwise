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

export function extractPermissionsDenyList(
  parsed: Record<string, unknown>,
): string[] {
  const perms = parsed.permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return [];
  const deny = (perms as Record<string, unknown>).deny;
  if (!Array.isArray(deny)) return [];
  return deny.filter((item): item is string => typeof item === "string");
}

export function denyEntriesProtectClaudeSettings(
  denyEntries: readonly string[],
): boolean {
  const checkTool = (tool: "Edit" | "Write"): boolean => {
    let coversSettingsJson = false;
    let coversSettingsLocalJson = false;
    const bareRe = new RegExp(`^${tool}$`, "i");
    const callRe = new RegExp(`^${tool}\\(\\s*(.*?)\\s*\\)$`, "i");

    for (const raw of denyEntries) {
      const trimmed = raw.trim();
      if (bareRe.test(trimmed)) {
        return true;
      }
      const match = callRe.exec(trimmed);
      if (!match?.[1]) continue;
      const pattern = match[1]
        .trim()
        .replace(/^["']|["']$/g, "")
        .replaceAll("\\", "/");
      if (
        pattern === "*" ||
        pattern === "**" ||
        pattern === "**/*" ||
        pattern === "." ||
        pattern === "./*" ||
        pattern === "./**" ||
        pattern === "/*" ||
        pattern === "/**"
      ) {
        return true;
      }
      const rel = pattern.replace(/^(?:\.\/|\/)?(?:\*\*\/)?/, "").toLowerCase();
      if (
        rel === ".claude" ||
        rel === ".claude/" ||
        rel === ".claude/*" ||
        rel === ".claude/**" ||
        rel === ".claude/**/*" ||
        rel === ".claude/*.json" ||
        rel === ".claude/**/*.json" ||
        /^\.claude\/settings(?:\*|\.\*)/.test(rel)
      ) {
        return true;
      }
      if (rel === ".claude/settings.json") {
        coversSettingsJson = true;
      }
      if (
        rel === ".claude/settings.local.json" ||
        rel === ".claude/*.local.json" ||
        rel === ".claude/settings.local*"
      ) {
        coversSettingsLocalJson = true;
      }
    }

    return coversSettingsJson && coversSettingsLocalJson;
  };

  return checkTool("Edit") && checkTool("Write");
}

export function hasClaudeSettingsWriteDeny(
  parsed: Record<string, unknown>,
): boolean {
  return denyEntriesProtectClaudeSettings(extractPermissionsDenyList(parsed));
}

export function hasPreToolUseHook(parsed: Record<string, unknown>): boolean {
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const preToolUse = (hooks as Record<string, unknown>).PreToolUse;
  return Array.isArray(preToolUse) && preToolUse.length > 0;
}

function hasDeniedMcpServers(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return false;
}

export function hasConnectorOrHookGuard(
  parsed: Record<string, unknown>,
): boolean {
  return (
    hasPreToolUseHook(parsed) ||
    parsed.disableClaudeAiConnectors === true ||
    hasDeniedMcpServers(parsed.deniedMcpServers)
  );
}

function isClaudeSettingsPath(normalizedPath: string): boolean {
  return (
    /^settings(?:\.local)?\.json$/i.test(normalizedPath) ||
    /^claude-home\/(?:\.claude\/)?settings(?:\.local)?\.json$/i.test(
      normalizedPath,
    ) ||
    /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/i.test(normalizedPath)
  );
}

/**
 * True for project-level MCP server config files read by Claude Code
 * (`.mcp.json`), Cursor (`.cursor/mcp.json`), and VS Code / GitHub Copilot
 * (`.vscode/mcp.json`).
 */
export function isMcpConfigPath(displayPath: string): boolean {
  const normalized = displayPath.replaceAll("\\", "/");
  return /(?:^|\/)(?:\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json)$/i.test(
    normalized,
  );
}

/**
 * Strip `//` and `/* *\/` comments (outside of strings) and trailing commas so
 * JSONC MCP configs such as `.vscode/mcp.json` can be parsed.
 */
export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = input.indexOf("*/", i + 2);
      const block = end === -1 ? input.slice(i) : input.slice(i, end + 2);
      out += block.replace(/[^\n]/g, " ");
      i = end === -1 ? input.length : end + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse an MCP config file (JSON or JSONC) and return its server map, reading
 * `"mcpServers"` (Claude Code / Cursor) or `"servers"` (VS Code `.vscode/mcp.json`).
 * Returns `undefined` when the content is not a valid MCP config object.
 */
export function parseMcpConfigServers(
  content: string,
): Record<string, Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = JSON.parse(stripJsonComments(content));
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const raw = parsed as Record<string, unknown>;
  const servers = raw.mcpServers ?? raw.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return undefined;
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(
    servers as Record<string, unknown>,
  )) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      result[name] = entry as Record<string, unknown>;
    }
  }
  return result;
}

export function isMcpServerDisabled(entry: Record<string, unknown>): boolean {
  return entry.disabled === true || entry.enabled === false;
}

export interface UnpinnedMcpExec {
  runner: string;
  spec: string;
  packageName: string;
  ecosystem: "npm" | "python";
}

const NPX_VALUE_FLAGS = new Set([
  "-p",
  "--package",
  "-c",
  "--call",
  "--cache",
  "--registry",
  "--userconfig",
  "--prefix",
  "-w",
  "--workspace",
  "--node-options",
  "--script-shell",
  "--loglevel",
]);
const NPX_PACKAGE_FLAGS = new Set(["-p", "--package"]);
const BUNX_VALUE_FLAGS = new Set(["-p", "--package", "--cwd", "--registry"]);
const PNPM_DLX_VALUE_FLAGS = new Set([
  "--package",
  "-C",
  "--dir",
  "--reporter",
  "--loglevel",
  "--registry",
]);
const PNPM_PACKAGE_FLAGS = new Set(["--package"]);
const YARN_DLX_VALUE_FLAGS = new Set(["-p", "--package"]);
const UVX_VALUE_FLAGS = new Set([
  "--from",
  "--with",
  "--with-editable",
  "--with-requirements",
  "-w",
  "--python",
  "-p",
  "--index",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--default-index",
  "--find-links",
  "-f",
  "--directory",
  "--project",
  "--cache-dir",
  "--config-file",
  "--constraints",
  "-c",
  "--overrides",
  "--build-constraints",
  "-b",
  "--env-file",
  "--python-platform",
  "--exclude-newer",
  "--index-strategy",
  "--keyring-provider",
  "--resolution",
  "--prerelease",
  "--refresh-package",
  "--reinstall-package",
  "--upgrade-package",
  "-P",
  "--color",
  "--allow-insecure-host",
]);
const UVX_PACKAGE_FLAGS = new Set(["--from"]);
const UVX_EXTRA_PACKAGE_FLAGS = new Set(["--with", "-w"]);
const PIPX_RUN_VALUE_FLAGS = new Set([
  "--spec",
  "--python",
  "--pip-args",
  "--index-url",
  "-i",
]);
const PIPX_PACKAGE_FLAGS = new Set(["--spec"]);
const EMPTY_FLAGS = new Set<string>();

function normalizeExecutableName(command: string): string {
  const base =
    command
      .trim()
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return base.toLowerCase().replace(/\.(?:cmd|exe|bat|ps1|com)$/, "");
}

function collectRunnerSpecs(
  rest: readonly string[],
  valueFlags: ReadonlySet<string>,
  packageFlags: ReadonlySet<string>,
  extraPackageFlags: ReadonlySet<string>,
): string[] {
  const specs: string[] = [];
  let replacedPositional = false;
  let positional: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--") {
      positional = rest[i + 1];
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      const flag = eq > 0 ? arg.slice(0, eq) : arg;
      if (valueFlags.has(flag)) {
        const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
        if (value !== undefined) {
          if (packageFlags.has(flag)) {
            specs.push(value);
            replacedPositional = true;
          } else if (extraPackageFlags.has(flag)) {
            specs.push(value);
          }
        }
      }
      continue;
    }
    positional = arg;
    break;
  }
  if (!replacedPositional && positional !== undefined) {
    specs.unshift(positional);
  }
  return specs;
}

const EXACT_SEMVER =
  /^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const GIT_COMMIT_REF = /#[0-9a-f]{7,40}$/i;

function isLocalPathSpec(spec: string): boolean {
  return /^(?:\.{1,2}(?:[\\/]|$)|[\\/]|~[\\/]|[A-Za-z]:[\\/]|file:)/.test(spec);
}

type PinStatus =
  { status: "pinned" | "skip" } | { status: "unpinned"; packageName: string };

function classifyNpmSpec(rawSpec: string): PinStatus {
  const spec = rawSpec.trim().replace(/^npm:/, "");
  if (!spec || isLocalPathSpec(spec) || /^https?:\/\//i.test(spec)) {
    return { status: "skip" };
  }
  if (
    /^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec) ||
    /^[a-z0-9][\w.-]*\/[\w.-]+(?:#.*)?$/i.test(spec)
  ) {
    return GIT_COMMIT_REF.test(spec)
      ? { status: "pinned" }
      : { status: "unpinned", packageName: spec.replace(/#.*$/, "") };
  }
  const versionAt = spec.startsWith("@")
    ? spec.indexOf("@", 1)
    : spec.indexOf("@");
  const name = versionAt > 0 ? spec.slice(0, versionAt) : spec;
  const version = versionAt > 0 ? spec.slice(versionAt + 1) : "";
  if (!NPM_PACKAGE_NAME.test(name)) return { status: "skip" };
  if (version && EXACT_SEMVER.test(version)) return { status: "pinned" };
  return { status: "unpinned", packageName: name };
}

function classifyPythonSpec(rawSpec: string): PinStatus {
  const spec = rawSpec.trim();
  if (!spec || isLocalPathSpec(spec) || /^https?:\/\//i.test(spec)) {
    return { status: "skip" };
  }
  if (/^git\+/i.test(spec)) {
    return /@[0-9a-f]{7,40}(?:#.*)?$/i.test(spec)
      ? { status: "pinned" }
      : { status: "unpinned", packageName: spec.replace(/@[^@/]*$/, "") };
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(spec);
  if (!match?.[1]) return { status: "skip" };
  const name = match[1];
  const constraint = (match[3] ?? "").trim();
  if (/^===?\s*[^\s*,;]+$/.test(constraint)) return { status: "pinned" };
  const atVersion = /^@\s*(.+)$/.exec(constraint)?.[1]?.trim();
  if (atVersion && /^\d[\w.!+-]*$/.test(atVersion)) {
    return { status: "pinned" };
  }
  if (constraint.includes("/") || constraint.includes("\\")) {
    return { status: "skip" };
  }
  return { status: "unpinned", packageName: name };
}

/**
 * Detect auto-installing package runners (`npx`, `npm exec`, `bunx`,
 * `pnpm dlx`, `yarn dlx`, `uvx`, `uv tool run`, `pipx run`) that execute an
 * unpinned or `@latest` package specifier inside an MCP server declaration.
 */
export function findUnpinnedMcpExec(
  command: string,
  args: readonly string[] = [],
): UnpinnedMcpExec[] {
  let argv = [command, ...args].filter(
    (part): part is string => typeof part === "string",
  );
  if (args.length === 0 && /\s/.test(command.trim())) {
    argv = command.trim().split(/\s+/);
  }
  let exe = normalizeExecutableName(argv[0] ?? "");
  let rest = argv.slice(1);
  if (exe === "cmd" && rest[0] && /^\/[cCkK]$/.test(rest[0])) {
    const inner = rest.slice(1);
    argv =
      inner.length === 1 && /\s/.test(inner[0] ?? "")
        ? (inner[0] as string).trim().split(/\s+/)
        : inner;
    exe = normalizeExecutableName(argv[0] ?? "");
    rest = argv.slice(1);
  }

  let runner: string | undefined;
  let ecosystem: "npm" | "python" = "npm";
  let specs: string[] = [];

  if (
    exe === "npx" ||
    (exe === "npm" && (rest[0] === "exec" || rest[0] === "x"))
  ) {
    const runnerArgs = exe === "npx" ? rest : rest.slice(1);
    if (runnerArgs.includes("--no") || runnerArgs.includes("--no-install")) {
      return [];
    }
    runner = exe === "npx" ? "npx" : `npm ${rest[0]}`;
    specs = collectRunnerSpecs(
      runnerArgs,
      NPX_VALUE_FLAGS,
      NPX_PACKAGE_FLAGS,
      EMPTY_FLAGS,
    );
  } else if (exe === "bunx" || (exe === "bun" && rest[0] === "x")) {
    runner = exe === "bunx" ? "bunx" : "bun x";
    specs = collectRunnerSpecs(
      exe === "bunx" ? rest : rest.slice(1),
      BUNX_VALUE_FLAGS,
      NPX_PACKAGE_FLAGS,
      EMPTY_FLAGS,
    );
  } else if (exe === "pnpx" || (exe === "pnpm" && rest[0] === "dlx")) {
    runner = exe === "pnpx" ? "pnpx" : "pnpm dlx";
    specs = collectRunnerSpecs(
      exe === "pnpx" ? rest : rest.slice(1),
      PNPM_DLX_VALUE_FLAGS,
      PNPM_PACKAGE_FLAGS,
      EMPTY_FLAGS,
    );
  } else if (exe === "yarn" && rest[0] === "dlx") {
    runner = "yarn dlx";
    specs = collectRunnerSpecs(
      rest.slice(1),
      YARN_DLX_VALUE_FLAGS,
      NPX_PACKAGE_FLAGS,
      EMPTY_FLAGS,
    );
  } else if (
    exe === "uvx" ||
    (exe === "uv" && rest[0] === "tool" && rest[1] === "run")
  ) {
    runner = exe === "uvx" ? "uvx" : "uv tool run";
    ecosystem = "python";
    specs = collectRunnerSpecs(
      exe === "uvx" ? rest : rest.slice(2),
      UVX_VALUE_FLAGS,
      UVX_PACKAGE_FLAGS,
      UVX_EXTRA_PACKAGE_FLAGS,
    );
  } else if (exe === "pipx" && rest[0] === "run") {
    runner = "pipx run";
    ecosystem = "python";
    specs = collectRunnerSpecs(
      rest.slice(1),
      PIPX_RUN_VALUE_FLAGS,
      PIPX_PACKAGE_FLAGS,
      EMPTY_FLAGS,
    );
  }

  if (!runner) return [];
  const results: UnpinnedMcpExec[] = [];
  for (const spec of specs) {
    const verdict =
      ecosystem === "npm" ? classifyNpmSpec(spec) : classifyPythonSpec(spec);
    if (verdict.status === "unpinned") {
      results.push({
        runner,
        spec,
        packageName: verdict.packageName,
        ecosystem,
      });
    }
  }
  return results;
}

const MCP_AUTH_HEADER_NAMES =
  /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token)$/i;

function findLineIndex(
  lines: readonly string[],
  needle: string,
  fromIndex = 0,
): number {
  for (let i = Math.max(0, fromIndex); i < lines.length; i++) {
    if ((lines[i] ?? "").includes(needle)) return i;
  }
  return -1;
}

function scanMcpConfigServers(
  content: string,
  displayPath: string,
  lines: readonly string[],
  existing: readonly ShieldFinding[],
): ShieldFinding[] {
  const servers = parseMcpConfigServers(content);
  if (!servers) return [];
  const findings: ShieldFinding[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    if (isMcpServerDisabled(entry)) continue;
    const serverLineIdx = lines.findIndex((l) =>
      l.includes(`${JSON.stringify(name)}`),
    );

    const command = typeof entry.command === "string" ? entry.command : "";
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : [];
    if (command) {
      for (const hit of findUnpinnedMcpExec(command, args)) {
        let lineIdx = findLineIndex(
          lines,
          JSON.stringify(hit.spec),
          serverLineIdx,
        );
        if (lineIdx < 0)
          lineIdx = findLineIndex(lines, hit.spec, serverLineIdx);
        if (lineIdx < 0) lineIdx = serverLineIdx;
        const lineNumber = lineIdx >= 0 ? lineIdx + 1 : 1;
        const suggestion =
          hit.ecosystem === "npm"
            ? `${hit.packageName}@1.2.3`
            : `${hit.packageName}==1.2.3`;
        findings.push({
          id: "unpinned-mcp-exec",
          category: "unpinned-mcp-exec",
          severity: "medium",
          path: displayPath,
          line: lineNumber,
          message: `MCP server "${name}" auto-installs "${hit.spec}" via ${hit.runner} without a pinned version, so every session silently executes whatever the registry serves next (supply-chain rug-pull risk); pin an exact version such as "${suggestion}".`,
          snippet: maskSnippet(
            lines[lineNumber - 1] ?? `${hit.runner} ${hit.spec}`,
          ),
        });
      }
    }

    const headers = entry.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const [header, value] of Object.entries(
        headers as Record<string, unknown>,
      )) {
        if (typeof value !== "string" || !MCP_AUTH_HEADER_NAMES.test(header)) {
          continue;
        }
        const credential = value.replace(/^(?:Bearer|Basic|Token)\s+/i, "");
        if (
          credential.length < 16 ||
          /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/.test(credential) ||
          isPlaceholderSecret(credential)
        ) {
          continue;
        }
        let lineIdx = findLineIndex(lines, credential, serverLineIdx);
        if (lineIdx < 0) lineIdx = findLineIndex(lines, credential);
        const lineNumber = lineIdx >= 0 ? lineIdx + 1 : 1;
        if (
          existing.some(
            (f) =>
              f.category === "secret-exposure" &&
              f.line === lineNumber &&
              f.path === displayPath,
          )
        ) {
          continue;
        }
        const rawLine = lines[lineNumber - 1] ?? `"${header}": "***"`;
        findings.push({
          id: "mcp-inline-auth-header",
          category: "secret-exposure",
          severity: "high",
          path: displayPath,
          line: lineNumber,
          message: `MCP server "${name}" hardcodes a literal "${header}" credential header; reference an environment variable or input (e.g. "\${env:API_TOKEN}" / "\${input:token}") instead of committing the token.`,
          snippet: maskSnippet(
            rawLine.replace(
              credential,
              `${credential.slice(0, 4)}***REDACTED***`,
            ),
          ),
        });
      }
    }
  }

  return findings;
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

  // Check Claude Code settings.json / settings.local.json hygiene and mid-session hook bypasses (#105885, #106225)
  const normalizedDisplayPath = displayPath.replaceAll("\\", "/");
  if (isClaudeSettingsPath(normalizedDisplayPath)) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (
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

        if (parsed.disableAllHooks === true) {
          const lineIdx = lines.findIndex((l) =>
            /"disableAllHooks"\s*:/.test(l),
          );
          const lineNumber = lineIdx >= 0 ? lineIdx + 1 : 1;
          findings.push({
            id: "claude-settings-disable-all-hooks",
            category: "config-hygiene",
            severity: "high",
            path: displayPath,
            line: lineNumber,
            message:
              '"disableAllHooks": true hot-reloads mid-session in Claude Code and neutralizes PreToolUse MCP connector guards (anthropics/claude-code#106225); remove "disableAllHooks": true and protect .claude/** in permissions.deny.',
            snippet: maskSnippet(
              lines[lineNumber - 1] ?? '"disableAllHooks": true',
            ),
          });
        }

        if (
          hasConnectorOrHookGuard(parsed) &&
          !hasClaudeSettingsWriteDeny(parsed)
        ) {
          const guardLineIdx = lines.findIndex((l) =>
            /"(?:PreToolUse|hooks|disableClaudeAiConnectors|deniedMcpServers)"\s*:/.test(
              l,
            ),
          );
          const guardLineNumber = guardLineIdx >= 0 ? guardLineIdx + 1 : 1;
          findings.push({
            id: "claude-settings-unprotected-hook-guard",
            category: "config-hygiene",
            severity: "medium",
            path: displayPath,
            line: guardLineNumber,
            message:
              'PreToolUse MCP guard hook or connector restriction in Claude settings is not protected by permissions.deny against mid-session hot-reload tampering (anthropics/claude-code#106225); add "Edit(.claude/**)" and "Write(.claude/**)" to permissions.deny (and for claude.ai/code cloud sessions where disableClaudeAiConnectors/deniedMcpServers are ignored by the host, enforce a PreToolUse "^mcp__" matcher hook plus read-only settings).',
            snippet: maskSnippet(
              lines[guardLineNumber - 1] ?? '"PreToolUse": [...]',
            ),
          });
        }
      }
    } catch {
      // Ignore malformed JSON here
    }
  }

  // MCP server configs: .mcp.json (Claude Code), .cursor/mcp.json (Cursor), .vscode/mcp.json (VS Code "servers")
  if (isMcpConfigPath(normalizedDisplayPath)) {
    findings.push(
      ...scanMcpConfigServers(content, displayPath, lines, findings),
    );
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
        normalized.endsWith("/.cursor/mcp.json") ||
        normalized.endsWith("/.vscode/mcp.json") ||
        normalized.includes("/.codex/") ||
        normalized.includes("/.claude/") ||
        /\/\.claude\/rules\/.+\.md$/i.test(normalized) ||
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
  let findings: ShieldFinding[] = [];
  let scannedCount = candidateFiles.length;
  const projectDenyEntries: string[] = [];

  for (const filePath of candidateFiles) {
    const content = await readFile(filePath, "utf8").catch(() => "");
    if (!content) continue;
    const relPath = relative(root, filePath).replaceAll("\\", "/");
    if (isClaudeSettingsPath(relPath)) {
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          projectDenyEntries.push(...extractPermissionsDenyList(parsed));
        }
      } catch {
        // Ignore malformed JSON
      }
    }
    findings.push(...scanContentWithShield(content, relPath));
  }

  if (denyEntriesProtectClaudeSettings(projectDenyEntries)) {
    findings = findings.filter(
      (f) =>
        !(
          f.id === "claude-settings-unprotected-hook-guard" &&
          !f.path.startsWith("claude-home/")
        ),
    );
  }

  if (options.claudeHome) {
    const cHome = expandHomePath(options.claudeHome);
    const homeDirCandidates = [cHome];
    if (basename(cHome) !== ".claude") {
      homeDirCandidates.push(join(cHome, ".claude"));
    }
    const homeDenyEntries: string[] = [];
    for (const dirCandidate of homeDirCandidates) {
      let matchedDir = false;
      for (const fileName of ["settings.json", "settings.local.json"]) {
        const settingsPath = join(dirCandidate, fileName);
        if (candidateFiles.includes(settingsPath)) continue;
        if (!(await exists(settingsPath))) continue;
        const content = await readFile(settingsPath, "utf8").catch(() => "");
        if (!content) continue;
        matchedDir = true;
        scannedCount += 1;
        try {
          const parsed = JSON.parse(content) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            homeDenyEntries.push(...extractPermissionsDenyList(parsed));
          }
        } catch {
          // Ignore malformed JSON
        }
        const rel = relative(cHome, settingsPath).replaceAll("\\", "/");
        findings.push(...scanContentWithShield(content, `claude-home/${rel}`));
      }
      if (matchedDir) break;
    }

    if (denyEntriesProtectClaudeSettings(homeDenyEntries)) {
      findings = findings.filter(
        (f) =>
          !(
            f.id === "claude-settings-unprotected-hook-guard" &&
            f.path.startsWith("claude-home/")
          ),
      );
    }
    if (
      denyEntriesProtectClaudeSettings([
        ...projectDenyEntries,
        ...homeDenyEntries,
      ])
    ) {
      findings = findings.filter(
        (f) =>
          !(
            f.id === "claude-settings-unprotected-hook-guard" &&
            !f.path.startsWith("claude-home/")
          ),
      );
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
    {
      id: "claude-settings-disable-all-hooks",
      category: "config-hygiene",
      severity: "high",
      message:
        '"disableAllHooks": true hot-reloads mid-session in Claude Code and neutralizes PreToolUse MCP connector guards (anthropics/claude-code#106225); remove "disableAllHooks": true and protect .claude/** in permissions.deny.',
    },
    {
      id: "claude-settings-unprotected-hook-guard",
      category: "config-hygiene",
      severity: "medium",
      message:
        'PreToolUse MCP guard hook or connector restriction in Claude settings is not protected by permissions.deny against mid-session hot-reload tampering (anthropics/claude-code#106225); add "Edit(.claude/**)" and "Write(.claude/**)" to permissions.deny.',
    },
    {
      id: "unpinned-mcp-exec",
      category: "unpinned-mcp-exec",
      severity: "medium",
      message:
        "MCP server auto-installs an unpinned or @latest package via npx/bunx/pnpm dlx/uvx (supply-chain rug-pull risk); pin an exact version such as @scope/pkg@1.2.3 or pkg==1.2.3.",
    },
    {
      id: "mcp-inline-auth-header",
      category: "secret-exposure",
      severity: "high",
      message:
        "MCP server config hardcodes a literal credential header; reference an environment variable or input instead.",
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
