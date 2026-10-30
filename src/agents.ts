import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { expandHomePath } from "./mcp-xray.js";

export type SupportedAgentId = "claude" | "codex" | "cursor";

export interface AgentSurfaceFile {
  agent: SupportedAgentId;
  kind:
    | "guidance"
    | "skill"
    | "command"
    | "rule"
    | "mcp-config"
    | "memory"
    | "settings";
  path: string;
  characters: number;
  estimatedTokens: number;
}

export interface AgentSurfaceSummary {
  agent: SupportedAgentId;
  files: number;
  estimatedStartupTokens: number;
  sources: AgentSurfaceFile[];
}

export interface ClaudeSettingsHygiene {
  settingsFiles: string[];
  misplacedMcpServersPaths: string[];
  disableClaudeAiConnectors: boolean;
  deniedMcpServers: string[];
  autoMemoryFiles: string[];
}

export interface MultiAgentReport {
  provenance: "estimated";
  agents: Record<SupportedAgentId, AgentSurfaceSummary>;
  parityStatus: "synced" | "diverged" | "single-agent" | "missing";
  compressionPotentialTokens: number;
  claudeHygiene: ClaudeSettingsHygiene;
  companionSources: AgentSurfaceFile[];
  recommendations: string[];
}

export interface CompressionResult {
  originalCharacters: number;
  compressedCharacters: number;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  savedPercent: number;
  content: string;
}

export interface SyncAgentResult {
  sourcePath: string;
  writtenTargets: Array<{
    target: SupportedAgentId;
    path: string;
    estimatedTokens: number;
    savedTokens: number;
  }>;
  dryRun: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  root: string,
  predicate: (path: string, name: string) => boolean,
  depth = 4,
): Promise<string[]> {
  if (depth < 0 || !(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) {
      continue;
    }
    const full = join(root, entry.name);
    if (entry.isFile() && predicate(full, entry.name)) {
      results.push(full);
    } else if (entry.isDirectory()) {
      results.push(...(await walkFiles(full, predicate, depth - 1)));
    }
  }
  return results.sort();
}

export function compressMarkdownGuidance(content: string): CompressionResult {
  const originalCharacters = content.length;
  const originalTokens = Math.ceil(originalCharacters / 4);

  // Preserve fenced code blocks while compacting prose outside code blocks
  const segments = content.split(/(```[\s\S]*?```)/g);
  const seenBullets = new Set<string>();

  const compactedSegments = segments.map((segment, idx) => {
    if (idx % 2 === 1) {
      // Inside fenced code block: preserve verbatim
      return segment;
    }
    // Strip non-directive HTML comments
    const withoutComments = segment.replace(/<!--[\s\S]*?-->/g, "");
    const lines = withoutComments.split(/\r?\n/);
    const keptLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.replace(/[ \t]+$/g, "");
      const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(line);
      if (bulletMatch?.[1]) {
        const normalizedBullet = bulletMatch[1]
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        if (normalizedBullet.length > 20) {
          if (seenBullets.has(normalizedBullet)) continue;
          seenBullets.add(normalizedBullet);
        }
      }
      keptLines.push(line);
    }

    return keptLines.join("\n").replace(/\n{3,}/g, "\n\n");
  });

  const finalContent = `${compactedSegments.join("").trim()}\n`;
  const compressedCharacters = finalContent.trim() ? finalContent.length : 0;
  const compressedTokens = Math.ceil(compressedCharacters / 4);
  const savedTokens = Math.max(0, originalTokens - compressedTokens);
  const savedPercent =
    originalTokens > 0
      ? Number(((savedTokens / originalTokens) * 100).toFixed(1))
      : 0;

  return {
    originalCharacters,
    compressedCharacters,
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent,
    content: finalContent,
  };
}

function normalizeForParity(content: string): string {
  return content
    .replace(/^<!--\s*ctxwise-synced.*?-->\r?\n?/gim, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDeniedMcpServerNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    const names: string[] = [];
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        names.push(item.trim());
      } else if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const name = record.serverName ?? record.name ?? record.server;
        if (typeof name === "string" && name.trim()) {
          names.push(name.trim());
        }
      }
    }
    return names;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

export async function auditMultiAgentSurface(options: {
  projectRoot: string;
  claudeHome?: string;
  codexHome?: string;
}): Promise<MultiAgentReport> {
  const root = resolve(options.projectRoot);
  const claudeSources: AgentSurfaceFile[] = [];
  const codexSources: AgentSurfaceFile[] = [];
  const cursorSources: AgentSurfaceFile[] = [];
  const companionSources: AgentSurfaceFile[] = [];

  const claudeHygiene: ClaudeSettingsHygiene = {
    settingsFiles: [],
    misplacedMcpServersPaths: [],
    disableClaudeAiConnectors: false,
    deniedMcpServers: [],
    autoMemoryFiles: [],
  };

  let potentialSavings = 0;

  const addFile = async (
    bucket: AgentSurfaceFile[],
    agent: SupportedAgentId,
    kind: AgentSurfaceFile["kind"],
    fullPath: string,
    displayPrefix = "project",
    baseDir = root,
  ) => {
    if (!(await exists(fullPath))) return;
    const raw = await readFile(fullPath, "utf8").catch(() => "");
    if (!raw.trim()) return;
    const rel = relative(baseDir, fullPath).replaceAll("\\", "/");
    const estimatedTokens = Math.ceil(raw.length / 4);
    if (kind === "guidance" || kind === "rule" || kind === "memory") {
      potentialSavings += compressMarkdownGuidance(raw).savedTokens;
    }
    bucket.push({
      agent,
      kind,
      path: `${displayPrefix}/${rel}`,
      characters: raw.length,
      estimatedTokens,
    });
  };

  const inspectClaudeSettingsFile = async (
    fullPath: string,
    displayPath: string,
  ) => {
    if (!(await exists(fullPath))) return;
    const raw = await readFile(fullPath, "utf8").catch(() => "");
    if (!raw.trim()) return;
    claudeHygiene.settingsFiles.push(displayPath);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed.mcpServers &&
        typeof parsed.mcpServers === "object" &&
        !Array.isArray(parsed.mcpServers)
      ) {
        claudeHygiene.misplacedMcpServersPaths.push(displayPath);
      }
      if (parsed.disableClaudeAiConnectors === true) {
        claudeHygiene.disableClaudeAiConnectors = true;
      }
      for (const denied of extractDeniedMcpServerNames(
        parsed.deniedMcpServers,
      )) {
        if (!claudeHygiene.deniedMcpServers.includes(denied)) {
          claudeHygiene.deniedMcpServers.push(denied);
        }
      }
    } catch {
      // Malformed JSON handled by shield/audit
    }
  };

  // 1. Claude Code surface
  for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) {
    await addFile(claudeSources, "claude", "guidance", join(root, name));
  }
  await addFile(claudeSources, "claude", "mcp-config", join(root, ".mcp.json"));

  await inspectClaudeSettingsFile(
    join(root, ".claude", "settings.json"),
    "project/.claude/settings.json",
  );
  await inspectClaudeSettingsFile(
    join(root, ".claude", "settings.local.json"),
    "project/.claude/settings.local.json",
  );

  const claudeCommands = await walkFiles(
    join(root, ".claude", "commands"),
    (_p, name) => name.endsWith(".md"),
    3,
  );
  for (const file of claudeCommands) {
    await addFile(claudeSources, "claude", "command", file);
  }

  const claudeSkills = await walkFiles(
    join(root, ".claude", "skills"),
    (_p, name) => name === "SKILL.md",
    4,
  );
  for (const file of claudeSkills) {
    await addFile(claudeSources, "claude", "skill", file);
  }

  if (options.claudeHome) {
    const cHome = expandHomePath(options.claudeHome);
    const directClaudeMd = join(cHome, "CLAUDE.md");
    const nestedClaudeMd = join(cHome, ".claude", "CLAUDE.md");
    if (await exists(directClaudeMd)) {
      await addFile(
        claudeSources,
        "claude",
        "guidance",
        directClaudeMd,
        "claude-home",
        cHome,
      );
    } else if (
      basename(cHome) !== ".claude" &&
      (await exists(nestedClaudeMd))
    ) {
      await addFile(
        claudeSources,
        "claude",
        "guidance",
        nestedClaudeMd,
        "claude-home",
        join(cHome, ".claude"),
      );
    }

    // Inspect user-level Claude settings.json
    const directSettings = join(cHome, "settings.json");
    const nestedSettings = join(cHome, ".claude", "settings.json");
    if (await exists(directSettings)) {
      await inspectClaudeSettingsFile(
        directSettings,
        "claude-home/settings.json",
      );
    } else if (
      basename(cHome) !== ".claude" &&
      (await exists(nestedSettings))
    ) {
      await inspectClaudeSettingsFile(
        nestedSettings,
        "claude-home/.claude/settings.json",
      );
    }

    // Discover Claude Code project auto-memory files (~/.claude/projects/<project-slug>/memory/*.md)
    const projectsRootCandidates = [join(cHome, "projects")];
    if (basename(cHome) !== ".claude") {
      projectsRootCandidates.push(join(cHome, ".claude", "projects"));
    }
    const baseNameSlug = basename(root);
    const slugCandidates = new Set([
      baseNameSlug,
      root.replace(/[:\\/]/g, "-"),
      root.replace(/[:\\/]+/g, "-"),
      root.replace(/[:\\/]+/g, "-").replace(/^-+/, ""),
    ]);

    const seenMemoryPaths = new Set<string>();
    for (const projectsRoot of projectsRootCandidates) {
      if (!(await exists(projectsRoot))) continue;
      const entries = await readdir(projectsRoot, {
        withFileTypes: true,
      }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const matchesProject =
          slugCandidates.has(entry.name) ||
          entry.name.endsWith(`-${baseNameSlug}`);
        if (!matchesProject) continue;
        const memoryDir = join(projectsRoot, entry.name, "memory");
        const memoryFiles = await walkFiles(
          memoryDir,
          (_p, name) => name.endsWith(".md"),
          2,
        );
        const homeBase = dirname(projectsRoot);
        for (const memFile of memoryFiles) {
          if (seenMemoryPaths.has(memFile)) continue;
          seenMemoryPaths.add(memFile);
          await addFile(
            claudeSources,
            "claude",
            "memory",
            memFile,
            "claude-home",
            homeBase,
          );
          const relMem = `claude-home/${relative(homeBase, memFile).replaceAll("\\", "/")}`;
          claudeHygiene.autoMemoryFiles.push(relMem);
        }
      }
    }
  }

  // 2. OpenAI Codex surface
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    await addFile(codexSources, "codex", "guidance", join(root, name));
  }
  const codexSkills = [
    ...(await walkFiles(
      join(root, ".codex", "skills"),
      (_p, name) => name === "SKILL.md",
      4,
    )),
    ...(await walkFiles(
      join(root, ".agents", "skills"),
      (_p, name) => name === "SKILL.md",
      4,
    )),
  ];
  for (const file of codexSkills) {
    await addFile(codexSources, "codex", "skill", file);
  }
  if (options.codexHome) {
    const xHome = expandHomePath(options.codexHome);
    await addFile(
      codexSources,
      "codex",
      "guidance",
      join(xHome, "AGENTS.md"),
      "codex-home",
      xHome,
    );
  }

  // 3. Cursor surface
  await addFile(cursorSources, "cursor", "rule", join(root, ".cursorrules"));
  const cursorMdcFiles = await walkFiles(
    join(root, ".cursor", "rules"),
    (_p, name) => name.endsWith(".mdc") || name.endsWith(".md"),
    3,
  );
  for (const file of cursorMdcFiles) {
    await addFile(cursorSources, "cursor", "rule", file);
  }

  // 4. Companion agent instruction surfaces (GEMINI.md, .github/copilot-instructions.md)
  await addFile(companionSources, "codex", "guidance", join(root, "GEMINI.md"));
  await addFile(
    companionSources,
    "codex",
    "guidance",
    join(root, ".github", "copilot-instructions.md"),
  );

  // Check parity between project CLAUDE.md and AGENTS.md
  const claudeMdPath = join(root, "CLAUDE.md");
  const agentsMdPath = join(root, "AGENTS.md");
  const hasClaudeMd = await exists(claudeMdPath);
  const hasAgentsMd = await exists(agentsMdPath);

  let parityStatus: MultiAgentReport["parityStatus"] = "missing";
  if (hasClaudeMd && hasAgentsMd) {
    const cHash = createHash("sha256")
      .update(normalizeForParity(await readFile(claudeMdPath, "utf8")))
      .digest("hex");
    const aHash = createHash("sha256")
      .update(normalizeForParity(await readFile(agentsMdPath, "utf8")))
      .digest("hex");
    parityStatus = cHash === aHash ? "synced" : "diverged";
  } else if (hasClaudeMd || hasAgentsMd) {
    parityStatus = "single-agent";
  }

  const recommendations: string[] = [];
  for (const misplacedPath of claudeHygiene.misplacedMcpServersPaths) {
    recommendations.push(
      `"mcpServers" found in ${misplacedPath}. Claude Code's update-config validator rejects "mcpServers" inside settings.json (causing +141k-token retry loops); move MCP server definitions to .mcp.json or ~/.claude.json.`,
    );
  }
  if (
    claudeHygiene.settingsFiles.length > 0 &&
    !claudeHygiene.disableClaudeAiConnectors &&
    claudeHygiene.deniedMcpServers.length === 0
  ) {
    recommendations.push(
      `Consider setting "disableClaudeAiConnectors": true or configuring "deniedMcpServers" in .claude/settings.json to prevent unrequested cloud connectors from injecting tool schemas.`,
    );
  }
  if (parityStatus === "diverged") {
    recommendations.push(
      "CLAUDE.md and AGENTS.md have diverged. Run `ctxwise sync` to align instructions across Claude Code and OpenAI Codex.",
    );
  } else if (parityStatus === "single-agent") {
    const present = hasClaudeMd ? "CLAUDE.md" : "AGENTS.md";
    const missing = hasClaudeMd ? "AGENTS.md" : "CLAUDE.md";
    recommendations.push(
      `Only ${present} is present. Run \`ctxwise sync\` to generate ${missing} so both Claude Code and OpenAI Codex share identical project rules.`,
    );
  }
  if (potentialSavings > 20) {
    recommendations.push(
      `Run \`ctxwise sync --compress\` to strip redundant boilerplate and save ~${potentialSavings.toLocaleString("en-US")} tokens per session.`,
    );
  }

  const summarize = (
    agent: SupportedAgentId,
    sources: AgentSurfaceFile[],
  ): AgentSurfaceSummary => ({
    agent,
    files: sources.length,
    estimatedStartupTokens: sources.reduce(
      (sum, item) => sum + item.estimatedTokens,
      0,
    ),
    sources,
  });

  return {
    provenance: "estimated",
    agents: {
      claude: summarize("claude", claudeSources),
      codex: summarize("codex", codexSources),
      cursor: summarize("cursor", cursorSources),
    },
    parityStatus,
    compressionPotentialTokens: potentialSavings,
    claudeHygiene,
    companionSources,
    recommendations,
  };
}

export async function syncAgentGuidance(options: {
  projectRoot: string;
  from?: "agents" | "claude" | "auto";
  targets?: SupportedAgentId[];
  compress?: boolean;
  dryRun?: boolean;
}): Promise<SyncAgentResult> {
  const root = resolve(options.projectRoot);
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");

  const hasAgents = await exists(agentsPath);
  const hasClaude = await exists(claudePath);

  let sourcePath: string;
  let sourceAgent: SupportedAgentId;

  if (options.from === "claude") {
    if (!hasClaude)
      throw new Error("CLAUDE.md does not exist in project root.");
    sourcePath = claudePath;
    sourceAgent = "claude";
  } else if (options.from === "agents") {
    if (!hasAgents)
      throw new Error("AGENTS.md does not exist in project root.");
    sourcePath = agentsPath;
    sourceAgent = "codex";
  } else {
    if (hasAgents) {
      sourcePath = agentsPath;
      sourceAgent = "codex";
    } else if (hasClaude) {
      sourcePath = claudePath;
      sourceAgent = "claude";
    } else {
      throw new Error(
        "Neither AGENTS.md nor CLAUDE.md found in project root to sync from.",
      );
    }
  }

  const rawContent = await readFile(sourcePath, "utf8");
  const compression = options.compress
    ? compressMarkdownGuidance(rawContent)
    : {
        content: rawContent,
        compressedTokens: Math.ceil(rawContent.length / 4),
        savedTokens: 0,
      };

  const targetAgents: SupportedAgentId[] =
    options.targets && options.targets.length > 0
      ? options.targets
      : (["claude", "codex"] as SupportedAgentId[]);

  const writtenTargets: SyncAgentResult["writtenTargets"] = [];

  for (const target of targetAgents) {
    if (target === sourceAgent && !options.compress) continue;
    let destination: string;
    let payload = compression.content;

    if (target === "claude") {
      destination = claudePath;
    } else if (target === "codex") {
      destination = agentsPath;
    } else {
      destination = join(root, ".cursor", "rules", "ctxwise.mdc");
      payload = `---\ndescription: Project rules synchronized by CtxWise\nglobs: "**/*"\nalwaysApply: true\n---\n\n${compression.content}`;
    }

    if (!options.dryRun) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, payload, "utf8");
    }

    writtenTargets.push({
      target,
      path: relative(root, destination).replaceAll("\\", "/"),
      estimatedTokens: Math.ceil(payload.length / 4),
      savedTokens: compression.savedTokens,
    });
  }

  return {
    sourcePath: relative(root, sourcePath).replaceAll("\\", "/"),
    writtenTargets,
    dryRun: Boolean(options.dryRun),
  };
}

export function renderMultiAgentReport(report: MultiAgentReport): string {
  const { claude, codex, cursor } = report.agents;
  const lines = [
    `CtxWise multi-agent · parity: ${report.parityStatus} · Claude ~${claude.estimatedStartupTokens.toLocaleString("en-US")} tokens (${claude.files} files) · Codex ~${codex.estimatedStartupTokens.toLocaleString("en-US")} tokens (${codex.files} files) · Cursor ~${cursor.estimatedStartupTokens.toLocaleString("en-US")} tokens (${cursor.files} files)`,
  ];

  if (
    report.claudeHygiene &&
    (report.claudeHygiene.settingsFiles.length > 0 ||
      report.claudeHygiene.autoMemoryFiles.length > 0 ||
      report.claudeHygiene.misplacedMcpServersPaths.length > 0)
  ) {
    lines.push(
      `Claude hygiene · disableClaudeAiConnectors: ${report.claudeHygiene.disableClaudeAiConnectors ? "true" : "false"} · deniedMcpServers: ${report.claudeHygiene.deniedMcpServers.length} · auto-memory: ${report.claudeHygiene.autoMemoryFiles.length} files`,
    );
  }

  for (const summary of [claude, codex, cursor]) {
    if (summary.sources.length === 0) continue;
    lines.push("", `${summary.agent.toUpperCase()} active context files:`);
    for (const file of summary.sources) {
      lines.push(
        `- ~${file.estimatedTokens.toLocaleString("en-US")} tokens · ${file.kind} · ${file.path}`,
      );
    }
  }

  if (report.companionSources && report.companionSources.length > 0) {
    lines.push("", "COMPANION active context files:");
    for (const file of report.companionSources) {
      lines.push(
        `- ~${file.estimatedTokens.toLocaleString("en-US")} tokens · ${file.kind} · ${file.path}`,
      );
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
