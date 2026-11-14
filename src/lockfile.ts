import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  discoverProjectGuidance,
  guidanceCandidateFilenames,
  readEffectiveGuidanceConfig,
} from "./guidance.js";
import { parseJsonc } from "./mcp-xray.js";
import { CTXWISE_VERSION } from "./version.js";

export interface CapabilityLockEntry {
  scope: "codex-home" | "project";
  path: string;
  sha256: string;
  bytes: number;
  redacted: boolean;
}

export interface CapabilityLock {
  schemaVersion: 1;
  generator: { name: "ctxwise" | "ctxray"; version: string };
  generatedAt: string;
  provenance: "local-files";
  includeMultiAgent?: boolean;
  entries: CapabilityLockEntry[];
}

export type CapabilityLockfile = CapabilityLock;

export interface CapabilityLockInput {
  codexHome: string;
  projectRoot: string;
  workingDirectory?: string;
  includeMultiAgent?: boolean;
  now?: Date;
  version?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function walk(root: string, depth = 5): Promise<string[]> {
  if (depth < 0 || !(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      [
        ".git",
        "node_modules",
        "dist",
        "coverage",
        ".ctxray",
        ".ctxwise",
      ].includes(entry.name)
    )
      continue;
    const path = join(root, entry.name);
    if (entry.isFile()) files.push(path);
    if (entry.isDirectory()) files.push(...(await walk(path, depth - 1)));
  }
  return files;
}

const secretKey =
  /(?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key)/i;
const jsonSecretKey =
  /(?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?key|signing[_-]?key|token|secret|password|passwd|authorization|bearer|cookie|credential)/i;
const inlineSecretPatterns: ReadonlyArray<RegExp> = [
  /\bBearer\s+\S+/gi,
  /\bBasic\s+\S+/gi,
  /\bsk-(?:ant-(?:api03-)?)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|$)/g,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'/@]*:[^\s"'/@]{6,}@[^\s"']+/g,
];

type ContentSanitizer = (raw: string) => {
  content: string;
  redacted: boolean;
};

export function redactSensitiveContent(content: string): {
  content: string;
  redacted: boolean;
} {
  let insideEnv = false;
  let redacted = false;
  const lines = content.split(/\r?\n/).map((line) => {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) insideEnv = /(?:^|\.)env$/i.test(section[1] ?? "");
    const assignment = /^(\s*)([A-Za-z0-9_.-]+)(\s*=)(.*)$/.exec(line);
    if (!assignment) return line;
    const key = assignment[2] ?? "";
    if (!insideEnv && !secretKey.test(key)) return line;
    redacted = true;
    return `${assignment[1]}${key}${assignment[3]} "***REDACTED***"`;
  });
  return { content: lines.join("\n"), redacted };
}

function isSensitiveJsonKey(key: string, insideHeaders: boolean): boolean {
  if (/^apiKeyHelper$/i.test(key)) return false;
  if (insideHeaders && /^(?:key|x-auth|auth)$/i.test(key)) return true;
  return jsonSecretKey.test(key);
}

function redactInlineStringSecrets(value: string): {
  value: string;
  redacted: boolean;
} {
  let updated = value;
  let redacted = false;
  if (/^\s*(?:Bearer|Basic)\s+\S+$/i.test(updated)) {
    return { value: "<redacted>", redacted: true };
  }
  for (const pattern of inlineSecretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(updated)) {
      redacted = true;
      pattern.lastIndex = 0;
      updated = updated.replace(pattern, "<redacted>");
    }
  }
  return { value: updated, redacted };
}

function parseJsonOrJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return parseJsonc(raw);
  }
}

/**
 * Deterministically canonicalize and sanitize JSON/JSONC configs (`.claude/settings*.json`,
 * `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) before hashing. Secrets, tokens,
 * API keys, env entries, and `Authorization` / `Bearer` headers become `"<redacted>"`,
 * while `hooks`, `disableAllHooks`, `permissions`, and MCP server definitions are preserved.
 */
export function sanitizeJsonConfigForHash(raw: string): {
  content: string;
  redacted: boolean;
} {
  let parsed: unknown;
  try {
    parsed = parseJsonOrJsonc(raw);
  } catch {
    const lineSafe = redactSensitiveContent(raw);
    const inlineSafe = redactInlineStringSecrets(lineSafe.content);
    const headerSafe = inlineSafe.value.replace(
      /("(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|token|secret|password|api_key|apiKey)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"<redacted>"',
    );
    const redacted =
      lineSafe.redacted ||
      inlineSafe.redacted ||
      headerSafe !== lineSafe.content;
    return { content: headerSafe, redacted };
  }

  let redacted = false;
  const sanitizeNode = (
    node: unknown,
    key: string | undefined,
    insideEnv: boolean,
    insideHeaders: boolean,
  ): unknown => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) {
      return node.map((item) =>
        sanitizeNode(item, undefined, insideEnv, false),
      );
    }
    if (typeof node === "object") {
      const entries = Object.keys(node as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .map((childKey) => {
          const childVal = (node as Record<string, unknown>)[childKey];
          const childEnv = insideEnv || /^env$/i.test(childKey);
          const childHeaders = insideHeaders || /^headers$/i.test(childKey);
          return [
            childKey,
            sanitizeNode(childVal, childKey, childEnv, childHeaders),
          ] as const;
        });
      return Object.fromEntries(entries);
    }
    if (insideEnv) {
      redacted = true;
      return "<redacted>";
    }
    if (typeof node === "string") {
      if (key !== undefined && isSensitiveJsonKey(key, insideHeaders)) {
        redacted = true;
        return "<redacted>";
      }
      if (insideHeaders && /^\s*(?:Bearer|Basic|Token)\s+\S+/i.test(node)) {
        redacted = true;
        return "<redacted>";
      }
      const inline = redactInlineStringSecrets(node);
      if (inline.redacted) {
        redacted = true;
        return inline.value;
      }
      return node;
    }
    if (
      typeof node === "number" &&
      key !== undefined &&
      isSensitiveJsonKey(key, insideHeaders) &&
      !/tokens$/i.test(key)
    ) {
      redacted = true;
      return "<redacted>";
    }
    return node;
  };

  const sanitized = sanitizeNode(parsed, undefined, false, false);
  return {
    content: JSON.stringify(sanitized, null, 2),
    redacted,
  };
}

function displayPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

async function entryFor(
  scope: CapabilityLockEntry["scope"],
  root: string,
  path: string,
  sanitizer: ContentSanitizer = redactSensitiveContent,
): Promise<CapabilityLockEntry> {
  return entryForContent(
    scope,
    root,
    path,
    await readFile(path, "utf8"),
    sanitizer,
  );
}

function entryForContent(
  scope: CapabilityLockEntry["scope"],
  root: string,
  path: string,
  raw: string,
  sanitizer: ContentSanitizer = redactSensitiveContent,
): CapabilityLockEntry {
  const safe = sanitizer(raw);
  return {
    scope,
    path: displayPath(root, path),
    sha256: createHash("sha256").update(safe.content).digest("hex"),
    bytes: Buffer.byteLength(safe.content),
    redacted: safe.redacted,
  };
}

const MULTI_AGENT_JSON_RELATIVE_PATHS: ReadonlyArray<readonly string[]> = [
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
  [".mcp.json"],
  [".cursor", "mcp.json"],
  [".vscode", "mcp.json"],
];

const MULTI_AGENT_TEXT_RELATIVE_PATHS: ReadonlyArray<readonly string[]> = [
  ["CLAUDE.md"],
  [".claude", "CLAUDE.md"],
  [".cursorrules"],
];

async function discoverMultiAgentFiles(
  projectRoot: string,
): Promise<Array<{ path: string; sanitizer: ContentSanitizer }>> {
  const root = resolve(projectRoot);
  const discovered: Array<{ path: string; sanitizer: ContentSanitizer }> = [];

  for (const segments of MULTI_AGENT_JSON_RELATIVE_PATHS) {
    const candidate = join(root, ...segments);
    if (await isRegularFile(candidate)) {
      discovered.push({
        path: candidate,
        sanitizer: sanitizeJsonConfigForHash,
      });
    }
  }

  for (const segments of MULTI_AGENT_TEXT_RELATIVE_PATHS) {
    const candidate = join(root, ...segments);
    if (await isRegularFile(candidate)) {
      discovered.push({ path: candidate, sanitizer: redactSensitiveContent });
    }
  }

  const claudeRulesDir = join(root, ".claude", "rules");
  const ruleFiles = (await walk(claudeRulesDir, 6))
    .filter((filePath) => filePath.toLowerCase().endsWith(".md"))
    .sort((left, right) => left.localeCompare(right));
  for (const ruleFile of ruleFiles) {
    discovered.push({ path: ruleFile, sanitizer: redactSensitiveContent });
  }

  return discovered;
}

export async function buildCapabilityLock(
  input: CapabilityLockInput,
): Promise<CapabilityLock> {
  const codexCandidates = (await walk(input.codexHome, 6)).filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    return (
      normalized.endsWith("/config.toml") ||
      normalized.endsWith(".config.toml") ||
      normalized.endsWith("/SKILL.md") ||
      normalized.includes("/agents/") ||
      normalized.includes("/hooks/")
    );
  });
  const guidanceConfig = await readEffectiveGuidanceConfig(
    input.codexHome,
    input.projectRoot,
  );
  const activeGuidance = await discoverProjectGuidance({
    projectRoot: input.projectRoot,
    workingDirectory: input.workingDirectory ?? input.projectRoot,
    config: guidanceConfig,
  });
  const guidanceNames = new Set(
    guidanceCandidateFilenames(guidanceConfig.fallbackFilenames),
  );
  const activeGuidancePaths = new Set(
    activeGuidance.map((document) => resolve(document.path)),
  );
  const projectCandidates = (await walk(input.projectRoot, 5)).filter(
    (path) => {
      const normalized = path.replaceAll("\\", "/");
      if (normalized.startsWith(input.codexHome.replaceAll("\\", "/")))
        return false;
      if (activeGuidancePaths.has(resolve(path))) return false;
      if (guidanceNames.has(basename(path))) return false;
      return (
        normalized.includes("/.codex/") ||
        normalized.includes("/.agents/skills/")
      );
    },
  );
  const seenProjectPaths = new Set<string>([
    ...activeGuidancePaths,
    ...projectCandidates.map((path) => resolve(path)),
  ]);
  const multiAgentCandidates = input.includeMultiAgent
    ? (await discoverMultiAgentFiles(input.projectRoot)).filter((item) => {
        const resolved = resolve(item.path);
        if (seenProjectPaths.has(resolved)) return false;
        seenProjectPaths.add(resolved);
        return true;
      })
    : [];
  const entries = await Promise.all([
    ...codexCandidates.map((path) =>
      entryFor("codex-home", input.codexHome, path),
    ),
    ...projectCandidates.map((path) =>
      entryFor("project", input.projectRoot, path),
    ),
    ...activeGuidance.map((document) =>
      Promise.resolve(
        entryForContent(
          "project",
          input.projectRoot,
          document.path,
          document.content,
        ),
      ),
    ),
    ...multiAgentCandidates.map((item) =>
      entryFor("project", input.projectRoot, item.path, item.sanitizer),
    ),
  ]);
  entries.sort((left, right) =>
    `${left.scope}/${left.path}`.localeCompare(`${right.scope}/${right.path}`),
  );
  return {
    schemaVersion: 1,
    generator: { name: "ctxwise", version: input.version ?? CTXWISE_VERSION },
    generatedAt: (input.now ?? new Date()).toISOString(),
    provenance: "local-files",
    ...(input.includeMultiAgent ? { includeMultiAgent: true } : {}),
    entries,
  };
}
