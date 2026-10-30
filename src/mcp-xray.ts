import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { parse as parseToml } from "smol-toml";

export interface McpServerDeclaration {
  name: string;
  source: "project-mcp-json" | "claude-home" | "codex-project" | "codex-home";
  transport: "stdio" | "http" | "unknown";
  command?: string;
  args?: string[];
  url?: string;
}

export interface McpToolSchemaMetric {
  server: string;
  name: string;
  descriptionCharacters: number;
  schemaCharacters: number;
  propertyCount: number;
  estimatedTokens: number;
  bloated: boolean;
}

export interface McpXrayReport {
  provenance: "estimated";
  serversDeclared: McpServerDeclaration[];
  toolsAnalyzed: McpToolSchemaMetric[];
  totalSchemaCharacters: number;
  estimatedTotalSchemaTokens: number;
  bloatedTools: McpToolSchemaMetric[];
  treeShakePotentialTokens: number;
  recommendations: string[];
}

export interface McpPruneFileChange {
  path: string;
  backupPath: string | null;
  disabledServers: string[];
  dryRun: boolean;
}

export interface McpPruneReport {
  provenance: "estimated";
  mode: "inspect" | "prune";
  dryRun: boolean;
  serversDeclared: McpServerDeclaration[];
  candidateServers: string[];
  disabledServers: string[];
  modifiedFiles: McpPruneFileChange[];
  bloatedTools: McpToolSchemaMetric[];
  estimatedSavedTokens: number;
  recommendations: string[];
}

export function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function resolveClaudeJsonCandidates(claudeHome: string): string[] {
  const base = expandHomePath(claudeHome);
  const candidates = [join(base, ".claude.json")];
  if (basename(base) === ".claude") {
    candidates.push(join(dirname(base), ".claude.json"));
  } else {
    candidates.push(join(base, ".claude", ".claude.json"));
  }
  return [...new Set(candidates)];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function extractJsonMcpServers(
  raw: Record<string, unknown>,
  source: McpServerDeclaration["source"],
): McpServerDeclaration[] {
  const container =
    raw.mcpServers && typeof raw.mcpServers === "object"
      ? (raw.mcpServers as Record<string, unknown>)
      : raw;
  const declarations: McpServerDeclaration[] = [];
  for (const [name, value] of Object.entries(container)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const command =
      typeof record.command === "string" ? record.command : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === "string")
      : undefined;
    if (!command && !url && raw.mcpServers === undefined) continue;
    declarations.push({
      name,
      source,
      transport: command ? "stdio" : url ? "http" : "unknown",
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
    });
  }
  return declarations;
}

function extractTomlMcpServers(
  raw: Record<string, unknown>,
  source: McpServerDeclaration["source"],
): McpServerDeclaration[] {
  const mcp = raw.mcp_servers;
  if (!mcp || typeof mcp !== "object") return [];
  const declarations: McpServerDeclaration[] = [];
  for (const [name, value] of Object.entries(mcp as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.enabled === false) continue;
    const command =
      typeof record.command === "string" ? record.command : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    const args = Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === "string")
      : undefined;
    declarations.push({
      name,
      source,
      transport: command ? "stdio" : url ? "http" : "unknown",
      ...(command ? { command } : {}),
      ...(args ? { args } : {}),
      ...(url ? { url } : {}),
    });
  }
  return declarations;
}

export async function discoverMcpDeclarations(options: {
  projectRoot: string;
  codexHome?: string;
  claudeHome?: string;
}): Promise<McpServerDeclaration[]> {
  const root = resolve(options.projectRoot);
  const declarations: McpServerDeclaration[] = [];

  const projectMcpJson = join(root, ".mcp.json");
  if (await exists(projectMcpJson)) {
    try {
      const parsed = JSON.parse(
        await readFile(projectMcpJson, "utf8"),
      ) as Record<string, unknown>;
      declarations.push(...extractJsonMcpServers(parsed, "project-mcp-json"));
    } catch {
      // Ignore malformed JSON here; handled by audit/shield
    }
  }

  const projectCodexToml = join(root, ".codex", "config.toml");
  if (await exists(projectCodexToml)) {
    try {
      const parsed = parseToml(
        await readFile(projectCodexToml, "utf8"),
      ) as Record<string, unknown>;
      declarations.push(...extractTomlMcpServers(parsed, "codex-project"));
    } catch {
      // Ignore malformed TOML
    }
  }

  if (options.codexHome) {
    const codexConfig = join(expandHomePath(options.codexHome), "config.toml");
    if (await exists(codexConfig)) {
      try {
        const parsed = parseToml(await readFile(codexConfig, "utf8")) as Record<
          string,
          unknown
        >;
        declarations.push(...extractTomlMcpServers(parsed, "codex-home"));
      } catch {
        // Ignore
      }
    }
  }

  if (options.claudeHome) {
    const seenClaudeServers = new Set<string>();
    for (const claudeJson of resolveClaudeJsonCandidates(options.claudeHome)) {
      if (!(await exists(claudeJson))) continue;
      try {
        const parsed = JSON.parse(await readFile(claudeJson, "utf8")) as Record<
          string,
          unknown
        >;
        for (const decl of extractJsonMcpServers(parsed, "claude-home")) {
          if (seenClaudeServers.has(decl.name)) continue;
          seenClaudeServers.add(decl.name);
          declarations.push(decl);
        }
      } catch {
        // Ignore
      }
    }
  }

  return declarations;
}

export function analyzeMcpToolsPayload(
  payload: unknown,
  defaultServer = "default",
): McpToolSchemaMetric[] {
  const toolsArray: Array<{ server: string; tool: Record<string, unknown> }> =
    [];

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === "object") {
        toolsArray.push({
          server: defaultServer,
          tool: item as Record<string, unknown>,
        });
      }
    }
  } else if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.tools)) {
      for (const item of record.tools) {
        if (item && typeof item === "object") {
          toolsArray.push({
            server:
              typeof record.server === "string" ? record.server : defaultServer,
            tool: item as Record<string, unknown>,
          });
        }
      }
    } else if (
      record.result &&
      typeof record.result === "object" &&
      Array.isArray((record.result as Record<string, unknown>).tools)
    ) {
      const resultTools = (record.result as Record<string, unknown>)
        .tools as unknown[];
      for (const item of resultTools) {
        if (item && typeof item === "object") {
          toolsArray.push({
            server: defaultServer,
            tool: item as Record<string, unknown>,
          });
        }
      }
    } else if (record.servers && typeof record.servers === "object") {
      for (const [serverName, serverData] of Object.entries(
        record.servers as Record<string, unknown>,
      )) {
        for (const metric of analyzeMcpToolsPayload(serverData, serverName)) {
          toolsArray.push({
            server: serverName,
            tool: {
              name: metric.name,
              _precomputed: metric,
            },
          });
        }
      }
    }
  }

  const metrics: McpToolSchemaMetric[] = [];
  for (const entry of toolsArray) {
    if (entry.tool._precomputed) {
      metrics.push(entry.tool._precomputed as McpToolSchemaMetric);
      continue;
    }
    const name =
      typeof entry.tool.name === "string" ? entry.tool.name : "unnamed_tool";
    const description =
      typeof entry.tool.description === "string" ? entry.tool.description : "";
    const inputSchema = entry.tool.inputSchema ?? entry.tool.parameters ?? {};
    const serialized = JSON.stringify({
      name,
      description,
      inputSchema,
    });
    const properties =
      inputSchema &&
      typeof inputSchema === "object" &&
      (inputSchema as Record<string, unknown>).properties &&
      typeof (inputSchema as Record<string, unknown>).properties === "object"
        ? Object.keys(
            (inputSchema as Record<string, unknown>).properties as Record<
              string,
              unknown
            >,
          ).length
        : 0;
    const schemaCharacters = serialized.length;
    const estimatedTokens = Math.ceil(schemaCharacters / 4);
    metrics.push({
      server: entry.server,
      name,
      descriptionCharacters: description.length,
      schemaCharacters,
      propertyCount: properties,
      estimatedTokens,
      bloated: estimatedTokens >= 250 || properties >= 12,
    });
  }

  return metrics.sort(
    (a, b) =>
      b.estimatedTokens - a.estimatedTokens || a.name.localeCompare(b.name),
  );
}

export async function probeStdioMcpServer(
  declaration: McpServerDeclaration,
  timeoutMs = 2500,
): Promise<McpToolSchemaMetric[]> {
  const command = declaration.command;
  if (declaration.transport !== "stdio" || !command) return [];
  const args = declaration.args ?? [];
  return new Promise<McpToolSchemaMetric[]>((resolveProbe) => {
    let settled = false;
    const finish = (result: McpToolSchemaMetric[]) => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, timeoutMs);

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.id === 2 && parsed.result) {
            clearTimeout(timer);
            child.kill();
            finish(analyzeMcpToolsPayload(parsed, declaration.name));
            return;
          }
        } catch {
          // Wait for complete JSON line
        }
      }
    });

    child.on("error", () => {
      clearTimeout(timer);
      finish([]);
    });

    child.on("close", () => {
      clearTimeout(timer);
      finish([]);
    });

    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ctxwise-mcp-xray", version: "1.0.0" },
      },
    });
    const listMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    try {
      child.stdin.write(`${initMsg}\n${listMsg}\n`);
    } catch {
      clearTimeout(timer);
      finish([]);
    }
  });
}

export function buildMcpXrayReport(input: {
  declarations: McpServerDeclaration[];
  tools: McpToolSchemaMetric[];
}): McpXrayReport {
  const totalSchemaCharacters = input.tools.reduce(
    (sum, tool) => sum + tool.schemaCharacters,
    0,
  );
  const estimatedTotalSchemaTokens = input.tools.reduce(
    (sum, tool) => sum + tool.estimatedTokens,
    0,
  );
  const bloatedTools = input.tools.filter((tool) => tool.bloated);
  const treeShakePotentialTokens = bloatedTools.reduce(
    (sum, tool) => sum + tool.estimatedTokens,
    0,
  );

  const recommendations: string[] = [];
  if (bloatedTools.length > 0) {
    recommendations.push(
      `Tree-shake ${bloatedTools.length} heavy MCP tool ${bloatedTools.length === 1 ? "schema" : "schemas"} to save ~${treeShakePotentialTokens.toLocaleString("en-US")} startup tokens per turn.`,
    );
  }
  if (input.declarations.length > 0 && input.tools.length === 0) {
    recommendations.push(
      "Pass --schema-file <tools.json> or --probe-stdio to measure live tool-schema token weights from configured MCP servers.",
    );
  }
  if (estimatedTotalSchemaTokens > 3000) {
    recommendations.push(
      "Split MCP servers into task-specific profiles (.mcp.json / Codex profiles) instead of loading all tools globally.",
    );
  }

  return {
    provenance: "estimated",
    serversDeclared: input.declarations,
    toolsAnalyzed: input.tools,
    totalSchemaCharacters,
    estimatedTotalSchemaTokens,
    bloatedTools,
    treeShakePotentialTokens,
    recommendations,
  };
}

export function renderMcpXrayReport(report: McpXrayReport): string {
  const lines = [
    `CtxWise mcp-xray · ${report.serversDeclared.length} MCP servers declared · ${report.toolsAnalyzed.length} tool schemas analyzed · ~${report.estimatedTotalSchemaTokens.toLocaleString("en-US")} schema tokens (estimated)`,
  ];

  if (report.serversDeclared.length > 0) {
    lines.push("", "Declared MCP servers:");
    for (const server of report.serversDeclared) {
      lines.push(`- ${server.name} (${server.source} · ${server.transport})`);
    }
  }

  if (report.toolsAnalyzed.length > 0) {
    lines.push("", "Heaviest MCP tool schemas:");
    for (const tool of report.toolsAnalyzed.slice(0, 10)) {
      const badge = tool.bloated ? " [BLOATED]" : "";
      lines.push(
        `- ~${tool.estimatedTokens.toLocaleString("en-US")} tokens · ${tool.server}/${tool.name} (${tool.propertyCount} params, ${tool.schemaCharacters.toLocaleString("en-US")} chars)${badge}`,
      );
    }
  }

  if (report.treeShakePotentialTokens > 0) {
    lines.push(
      "",
      `Tree-shaking potential: ~${report.treeShakePotentialTokens.toLocaleString("en-US")} tokens/turn savable by pruning bloated tools.`,
    );
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Recommendations:");
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function disableServerInTomlContent(
  content: string,
  serverName: string,
): { updated: string; changed: boolean } {
  const escaped = escapeRegExp(serverName);
  const headerRegex = new RegExp(
    `^\\s*\\[mcp_servers\\.(?:"${escaped}"|'${escaped}'|${escaped})\\]\\s*$`,
  );
  const lines = content.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => headerRegex.test(line));

  if (headerIdx === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return {
      updated: `${prefix}[mcp_servers.${serverName}]\nenabled = false\n`,
      changed: true,
    };
  }

  let nextSectionIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i]!)) {
      nextSectionIdx = i;
      break;
    }
  }

  for (let i = headerIdx + 1; i < nextSectionIdx; i++) {
    if (/^\s*enabled\s*=/.test(lines[i]!)) {
      if (/^\s*enabled\s*=\s*false\b/.test(lines[i]!)) {
        return { updated: content, changed: false };
      }
      lines[i] = "enabled = false";
      return { updated: `${lines.join("\n").trimEnd()}\n`, changed: true };
    }
  }

  lines.splice(headerIdx + 1, 0, "enabled = false");
  return { updated: `${lines.join("\n").trimEnd()}\n`, changed: true };
}

export async function pruneMcpServers(options: {
  projectRoot: string;
  codexHome?: string;
  claudeHome?: string;
  disableServers?: string[];
  tools?: McpToolSchemaMetric[];
  dryRun?: boolean;
  backup?: boolean;
}): Promise<McpPruneReport> {
  const root = resolve(options.projectRoot);
  const dryRun = Boolean(options.dryRun);
  const createBackup = options.backup !== false;
  const declarations = await discoverMcpDeclarations({
    projectRoot: root,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
    ...(options.claudeHome ? { claudeHome: options.claudeHome } : {}),
  });
  const tools = options.tools ?? [];
  const bloatedTools = tools.filter((t) => t.bloated);

  const requestedDisable = [
    ...new Set(
      (options.disableServers ?? [])
        .flatMap((entry) => entry.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  const bloatedServerNames = [...new Set(bloatedTools.map((t) => t.server))];
  const candidateServers =
    bloatedServerNames.length > 0
      ? bloatedServerNames
      : [...new Set(declarations.map((d) => d.name))];

  const modifiedFiles: McpPruneFileChange[] = [];
  const disabledServers = new Set<string>();

  if (requestedDisable.length > 0) {
    const projectMcpJson = join(root, ".mcp.json");
    if (await exists(projectMcpJson)) {
      try {
        const rawText = await readFile(projectMcpJson, "utf8");
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        const container =
          parsed.mcpServers && typeof parsed.mcpServers === "object"
            ? (parsed.mcpServers as Record<string, unknown>)
            : parsed;
        const removedHere: string[] = [];
        for (const name of requestedDisable) {
          if (Object.prototype.hasOwnProperty.call(container, name)) {
            delete container[name];
            removedHere.push(name);
            disabledServers.add(name);
          }
        }
        if (removedHere.length > 0) {
          const backupPath =
            !dryRun && createBackup ? `${projectMcpJson}.bak` : null;
          if (!dryRun) {
            if (backupPath) {
              await writeFile(backupPath, rawText, "utf8");
            }
            await writeFile(
              projectMcpJson,
              `${JSON.stringify(parsed, null, 2)}\n`,
              "utf8",
            );
          }
          modifiedFiles.push({
            path: projectMcpJson,
            backupPath,
            disabledServers: removedHere,
            dryRun,
          });
        }
      } catch {
        // Ignore invalid JSON
      }
    }

    const projectCodexToml = join(root, ".codex", "config.toml");
    const codexDeclaredNames = new Set(
      declarations
        .filter(
          (d) => d.source === "codex-project" || d.source === "codex-home",
        )
        .map((d) => d.name),
    );
    const tomlTargets = requestedDisable.filter(
      (name) => codexDeclaredNames.has(name) || !disabledServers.has(name),
    );

    if (
      tomlTargets.length > 0 &&
      ((await exists(projectCodexToml)) ||
        tomlTargets.some((n) => codexDeclaredNames.has(n)))
    ) {
      const hadToml = await exists(projectCodexToml);
      const originalToml = hadToml
        ? await readFile(projectCodexToml, "utf8")
        : "";
      let updatedToml = originalToml;
      const disabledInToml: string[] = [];

      for (const name of tomlTargets) {
        if (!hadToml && !codexDeclaredNames.has(name)) continue;
        const res = disableServerInTomlContent(updatedToml, name);
        if (res.changed) {
          updatedToml = res.updated;
          disabledInToml.push(name);
          disabledServers.add(name);
        }
      }

      if (disabledInToml.length > 0) {
        const backupPath =
          !dryRun && createBackup && hadToml ? `${projectCodexToml}.bak` : null;
        if (!dryRun) {
          await mkdir(dirname(projectCodexToml), { recursive: true });
          if (backupPath) {
            await writeFile(backupPath, originalToml, "utf8");
          }
          await writeFile(projectCodexToml, updatedToml, "utf8");
        }
        modifiedFiles.push({
          path: projectCodexToml,
          backupPath,
          disabledServers: disabledInToml,
          dryRun,
        });
      }
    }
  }

  const targetSet =
    requestedDisable.length > 0
      ? new Set(requestedDisable)
      : new Set(candidateServers);
  const estimatedSavedTokens =
    tools.length > 0
      ? tools
          .filter(
            (t) =>
              targetSet.has(t.server) &&
              (requestedDisable.length > 0 || t.bloated),
          )
          .reduce((sum, t) => sum + t.estimatedTokens, 0)
      : 0;

  const recommendations: string[] = [];
  if (requestedDisable.length === 0) {
    if (candidateServers.length > 0) {
      recommendations.push(
        `Run \`ctxwise mcp-prune --disable ${candidateServers.slice(0, 3).join(",")}\` (add \`--dry-run\` to preview) to disable unused MCP servers in .mcp.json / .codex/config.toml.`,
      );
    } else {
      recommendations.push(
        "No MCP servers declared in the active project or home configuration.",
      );
    }
  } else if (disabledServers.size === 0) {
    recommendations.push(
      `None of the requested servers (${requestedDisable.join(", ")}) were active in project .mcp.json or Codex config.toml.`,
    );
  }

  return {
    provenance: "estimated",
    mode: requestedDisable.length > 0 ? "prune" : "inspect",
    dryRun,
    serversDeclared: declarations,
    candidateServers,
    disabledServers: [...disabledServers],
    modifiedFiles,
    bloatedTools,
    estimatedSavedTokens,
    recommendations,
  };
}

export function renderMcpPruneReport(report: McpPruneReport): string {
  const modeLabel =
    report.mode === "prune"
      ? `${report.disabledServers.length} servers disabled${report.dryRun ? " (dry-run)" : ""}`
      : `${report.candidateServers.length} prunable servers identified`;
  const lines = [
    `CtxWise mcp-prune · ${modeLabel} · ~${report.estimatedSavedTokens.toLocaleString("en-US")} tokens/turn savable`,
  ];

  if (report.modifiedFiles.length > 0) {
    lines.push("", "Updated configuration files:");
    for (const file of report.modifiedFiles) {
      const backupNote = file.backupPath ? ` (backup: ${file.backupPath})` : "";
      lines.push(
        `- ${file.path}: disabled ${file.disabledServers.join(", ")}${file.dryRun ? " [dry-run]" : ""}${backupNote}`,
      );
    }
  } else if (report.candidateServers.length > 0) {
    lines.push("", "Candidate MCP servers to prune:");
    for (const name of report.candidateServers) {
      const decl = report.serversDeclared.find((d) => d.name === name);
      const sourceInfo = decl ? ` (${decl.source} · ${decl.transport})` : "";
      lines.push(`- ${name}${sourceInfo}`);
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
