#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";

import {
  auditMultiAgentSurface,
  renderMultiAgentReport,
  syncAgentGuidance,
  type SupportedAgentId,
} from "./agents.js";
import { queryAccountSnapshot, type AccountSnapshot } from "./app-server.js";
import { buildAuditSnapshot, renderAuditSnapshot } from "./audit-summary.js";
import { auditCodexSurface, resolveAuditPath } from "./audit.js";
import {
  evaluateContextBudget,
  parseContextBudgetPolicy,
  renderContextBudget,
} from "./budget.js";
import { loadPriceCatalog } from "./catalog.js";
import { resolveCodexInvocation } from "./codex-command.js";
import { renderCodexDoctorReport, runCodexDoctor } from "./codex-doctor.js";
import { renderContextMap } from "./context-map.js";
import {
  compareCapabilityLocks,
  parseCapabilityLock,
  type CapabilityDriftChange,
} from "./drift.js";
import { parseExecJsonl } from "./events.js";
import { buildCapabilityLock } from "./lockfile.js";
import {
  analyzeMcpToolsPayload,
  buildMcpXrayReport,
  discoverMcpDeclarations,
  expandHomePath,
  probeStdioMcpServer,
  pruneMcpServers,
  renderMcpPruneReport,
  renderMcpXrayReport,
  type McpToolSchemaMetric,
} from "./mcp-xray.js";
import { applyPresetToProject, listBuiltInPresets } from "./presets.js";
import { compileProfilesFromFile, installProfile } from "./profile.js";
import { resolveProjectScope } from "./guidance.js";
import { calculateReceipt, renderReceipt, type AuthMode } from "./receipt.js";
import { inspectPromptInput, runCodex } from "./runner.js";
import { renderShieldReport, runContextShield } from "./shield.js";
import { CTXWISE_VERSION } from "./version.js";
import { analyzePromptInput } from "./xray.js";

const program = new Command();
program
  .name("ctxwise")
  .description(
    "CtxWise: local-first context firewall, MCP schema tree-shaker, and token profiler for Claude Code, OpenAI Codex, and Cursor",
  )
  .version(CTXWISE_VERSION);

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function codexHome(value?: string): string {
  return expandHomePath(
    value ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  );
}

function claudeHome(value?: string): string {
  return expandHomePath(
    value ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  );
}

async function commandProjectScope(home: string, project?: string) {
  const base = {
    codexHome: home,
    workingDirectory: resolve(process.cwd()),
  };
  return resolveProjectScope(
    project ? { ...base, explicitProjectRoot: resolve(project) } : base,
  );
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${pc.yellow("warning:")} ${warning}\n`);
  }
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) {
    throw new InvalidArgumentError("Use a positive integer up to 100.");
  }
  return parsed;
}

function positiveTokenLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100_000_000) {
    throw new InvalidArgumentError(
      "Use a positive whole-token limit up to 100,000,000.",
    );
  }
  return parsed;
}

function renderDriftChange(change: CapabilityDriftChange): string {
  const marker =
    change.change === "added" ? "+" : change.change === "removed" ? "-" : "~";
  const before = change.before?.bytes;
  const after = change.after?.bytes;
  const size =
    before !== undefined && after !== undefined
      ? ` (${before.toLocaleString("en-US")} -> ${after.toLocaleString("en-US")} bytes)`
      : ` (${(after ?? before ?? 0).toLocaleString("en-US")} bytes)`;
  return `${marker} ${change.scope}/${change.path}${size}`;
}

program
  .command("run")
  .description("Run `codex exec --json` and optionally append a local receipt")
  .argument("<prompt...>", "Prompt passed to Codex")
  .option(
    "--model <model>",
    "Model used for the run and dated receipt pricing; omit to preserve Codex config",
  )
  .option("--profile <name>", "Native Codex profile")
  .option("--receipt", "Append the local receipt after the final answer", false)
  .option(
    "--prompt-xray",
    "Estimate the model-visible prompt before the turn without calling a model",
    false,
  )
  .option(
    "--api-equivalent",
    "Show subscription API equivalent as a comparison, never a charge",
    false,
  )
  .option("--pricing <file>", "Override the bundled dated price catalog")
  .option("--codex-command <path>", "Codex executable", "codex")
  .option(
    "--codex-prefix-arg <arg>",
    "Argument placed before the Codex subcommand; repeatable for adapters/tests",
    collect,
    [],
  )
  .action(async (prompt: string[], options) => {
    const invocation = await resolveCodexInvocation(options.codexCommand);
    const commandPrefixArgs = [
      ...invocation.prefixArgs,
      ...options.codexPrefixArg,
    ];
    const promptText = prompt.join(" ");
    let promptEstimate: { tokens: number; provenance: "estimated" } | null =
      null;
    if (options.receipt && options.promptXray) {
      try {
        const report = await inspectPromptInput({
          command: invocation.command,
          commandPrefixArgs,
          cwd: process.cwd(),
          model: options.model,
          profile: options.profile,
          prompt: promptText,
        });
        promptEstimate = {
          tokens: report.estimatedTokens,
          provenance: "estimated",
        };
      } catch (error) {
        process.stderr.write(
          `${pc.yellow("warning:")} prompt X-Ray unavailable: ${(error as Error).message}\n`,
        );
      }
    }
    const result = await runCodex({
      command: invocation.command,
      commandPrefixArgs,
      cwd: process.cwd(),
      model: options.model,
      profile: options.profile,
      prompt: promptText,
    });
    for (const message of result.messages) process.stdout.write(`${message}\n`);
    printWarnings(result.warnings);
    if (!options.receipt) return;
    if (!result.usage) {
      process.stdout.write("CtxWise receipt · token usage unknown\n");
      return;
    }
    let account: AccountSnapshot = {
      authMode: "unknown" as AuthMode,
      planType: null,
      quota: null,
    };
    try {
      account = await queryAccountSnapshot({
        command: invocation.command,
        commandPrefixArgs,
      });
    } catch (error) {
      process.stderr.write(
        `${pc.yellow("warning:")} quota unavailable: ${(error as Error).message}\n`,
      );
    }
    const catalog = await loadPriceCatalog(options.pricing);
    const receipt = calculateReceipt({
      authMode: account.authMode,
      catalog,
      includeApiEquivalent: options.apiEquivalent,
      model: options.model ?? "unknown",
      planType: account.planType,
      promptEstimate,
      quota: account.quota,
      usage: result.usage,
    });
    process.stdout.write(`${renderReceipt(receipt)}\n`);
    printWarnings(receipt.warnings);
  });

program
  .command("receipt")
  .description("Render a receipt from a saved `codex exec --json` stream")
  .argument("<jsonl>", "JSONL file")
  .addOption(
    new Option("--auth <mode>", "Authentication mode")
      .choices(["apikey", "chatgpt", "unknown"])
      .default("unknown"),
  )
  .requiredOption("--model <model>", "Model used for the turn")
  .option(
    "--api-equivalent",
    "Show comparison dollars for subscriptions",
    false,
  )
  .option("--pricing <file>", "Override the price catalog")
  .option("--json", "Print structured JSON", false)
  .action(async (path: string, options) => {
    const parsed = parseExecJsonl(
      (await readFile(resolve(path), "utf8")).split(/\r?\n/),
    );
    if (!parsed.usage)
      throw new Error("No valid turn.completed usage event was found.");
    const receipt = calculateReceipt({
      authMode: options.auth as AuthMode,
      catalog: await loadPriceCatalog(options.pricing),
      includeApiEquivalent: options.apiEquivalent,
      model: options.model,
      usage: parsed.usage,
    });
    if (options.json) printJson(receipt);
    else {
      process.stdout.write(`${renderReceipt(receipt)}\n`);
      printWarnings(receipt.warnings);
    }
  });

program
  .command("xray")
  .description(
    "Summarize Codex model-visible prompt JSON without echoing prompt text",
  )
  .argument("<prompt-input.json>", "Output from `codex debug prompt-input`")
  .option("--json", "Print structured JSON", false)
  .action(async (path: string, options) => {
    const report = analyzePromptInput(
      JSON.parse(await readFile(resolve(path), "utf8")),
    );
    if (options.json) printJson(report);
    else {
      process.stdout.write(
        `Estimated prompt size: ${report.estimatedTokens.toLocaleString("en-US")} tokens (${report.totalCharacters.toLocaleString("en-US")} characters)\n`,
      );
      for (const [role, summary] of Object.entries(report.byRole)) {
        process.stdout.write(
          `- ${role}: ${summary.items} items, ~${summary.estimatedTokens.toLocaleString("en-US")} tokens\n`,
        );
      }
    }
  });

program
  .command("snapshot")
  .description(
    "Show the largest known Codex context contributors and next actions",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--top <number>", "Maximum contributors to show", positiveInteger, 5)
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const report = await auditCodexSurface({
      codexHome: home,
      ...scope,
    });
    const snapshot = buildAuditSnapshot(report, { top: options.top });
    if (options.json) printJson(snapshot);
    else process.stdout.write(renderAuditSnapshot(snapshot));
  });

program
  .command("budget")
  .description("Check known local context against a reviewable token budget")
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--policy <file>", "Versioned YAML budget policy")
  .option(
    "--max-known-tokens <number>",
    "Maximum estimated known startup tokens",
    positiveTokenLimit,
  )
  .option(
    "--max-contributor-tokens <number>",
    "Maximum estimated tokens for the largest known contributor",
    positiveTokenLimit,
  )
  .addOption(
    new Option(
      "--unknown <mode>",
      "How unmeasured surfaces affect the budget",
    ).choices(["warn", "fail"]),
  )
  .option("--json", "Print structured JSON", false)
  .option(
    "--fail-on-exceed",
    "Exit with status 2 for blocking budget findings",
    false,
  )
  .action(async (options) => {
    const policy = options.policy
      ? parseContextBudgetPolicy(
          await readFile(resolve(options.policy), "utf8"),
        )
      : undefined;
    const maxKnownTokens = options.maxKnownTokens ?? policy?.maxKnownTokens;
    const maxContributorTokens =
      options.maxContributorTokens ?? policy?.maxContributorTokens;
    if (maxKnownTokens === undefined && maxContributorTokens === undefined) {
      throw new Error(
        "Provide --max-known-tokens, --max-contributor-tokens, or --policy with a numeric limit.",
      );
    }
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const audit = await auditCodexSurface({ codexHome: home, ...scope });
    const report = evaluateContextBudget(
      buildAuditSnapshot(audit, { top: 1 }),
      {
        maxKnownTokens,
        maxContributorTokens,
        unknown: options.unknown ?? policy?.unknown ?? "warn",
      },
    );
    if (options.json) printJson(report);
    else process.stdout.write(renderContextBudget(report));
    if (options.failOnExceed && report.summary.blocking > 0) {
      process.exitCode = 2;
    }
  });

program
  .command("audit")
  .description(
    "Audit Codex config, guidance, skills, agents, and MCP declarations",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const report = await auditCodexSurface({
      codexHome: home,
      ...scope,
    });
    if (options.json) printJson(report);
    else {
      process.stdout.write(
        `CtxWise audit · ~${report.estimatedKnownStartupTokens.toLocaleString("en-US")} known startup tokens · ${report.skills.length} skills · ${report.plugins.length} plugins · ${report.mcpServers.length} MCP servers\n`,
      );
      for (const finding of report.findings)
        process.stdout.write(`- [${finding.severity}] ${finding.message}\n`);
    }
  });

program
  .command("map")
  .description(
    "Render a bounded, local Mermaid map of the Codex context surface",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option(
    "--max-skills <number>",
    "Maximum skill detail nodes",
    positiveInteger,
    12,
  )
  .option(
    "--max-sources <number>",
    "Maximum config and guidance detail nodes",
    positiveInteger,
    12,
  )
  .option("--out <file>", "Write Mermaid to a file instead of stdout")
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const report = await auditCodexSurface({
      codexHome: home,
      ...scope,
    });
    const map = renderContextMap(report, {
      maxSkills: options.maxSkills,
      maxSources: options.maxSources,
    });
    if (options.out) {
      const destination = resolve(options.out);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, map, "utf8");
      process.stdout.write(`Wrote ${destination}\n`);
    } else {
      process.stdout.write(map);
    }
  });

program
  .command("profile")
  .description("Compile reviewable YAML into native Codex profile files")
  .argument("<policy.yaml>", "CtxWise policy file")
  .option("--out <directory>", "Staging output", ".ctxwise/profiles")
  .option("--install", "Install with backup into CODEX_HOME", false)
  .option("--codex-home <path>", "Codex home directory")
  .option("--dry-run", "Print generated TOML without writing", false)
  .action(async (path: string, options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home);
    const audit = await auditCodexSurface({
      codexHome: home,
      ...scope,
    });
    const pathCandidates = new Map<string, Set<string>>();
    for (const skill of audit.skills) {
      const absolutePath = resolveAuditPath(skill.path, {
        codexHome: home,
        projectRoot: scope.projectRoot,
      });
      if (!absolutePath) continue;
      const candidates = pathCandidates.get(skill.name) ?? new Set<string>();
      candidates.add(absolutePath);
      pathCandidates.set(skill.name, candidates);
    }
    const skillPaths = Object.fromEntries(
      [...pathCandidates]
        .filter(([, candidates]) => candidates.size === 1)
        .map(([name, candidates]) => [name, [...candidates][0]!]),
    );
    const profiles = await compileProfilesFromFile(resolve(path), {
      skillPaths,
    });
    for (const profile of profiles) {
      if (options.dryRun) {
        process.stdout.write(`# ${profile.fileName}\n${profile.toml}`);
      } else if (options.install) {
        const installed = await installProfile({
          codexHome: home,
          fileName: profile.fileName,
          toml: profile.toml,
        });
        process.stdout.write(`Installed ${installed.destination}\n`);
        if (installed.backupPath)
          process.stdout.write(`Backup ${installed.backupPath}\n`);
      } else {
        const destination = resolve(options.out, profile.fileName);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, profile.toml, "utf8");
        process.stdout.write(`Staged ${destination}\n`);
      }
      for (const warning of profile.warnings)
        process.stderr.write(`${pc.yellow("warning:")} ${warning}\n`);
    }
  });

program
  .command("lock")
  .description("Write a redacted capability lockfile")
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--out <file>", "Output path", "ctxwise.lock.json")
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const lock = await buildCapabilityLock({
      codexHome: home,
      ...scope,
    });
    await writeFile(
      resolve(options.out),
      `${JSON.stringify(lock, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `Wrote ${resolve(options.out)} (${lock.entries.length} entries)\n`,
    );
  });

program
  .command("drift")
  .description(
    "Compare a capability lock against a file or the live context surface",
  )
  .argument("[baseline]", "Baseline capability lockfile", "ctxwise.lock.json")
  .option(
    "--current <file>",
    "Compare with another lockfile instead of live context",
  )
  .option("--codex-home <path>", "Codex home directory for a live comparison")
  .option(
    "--project <path>",
    "Explicit project root for a live comparison; auto-detected by default",
  )
  .option("--json", "Print structured JSON", false)
  .option("--fail-on-drift", "Exit with status 2 when drift is detected", false)
  .action(async (baselinePath: string, options) => {
    const baseline = parseCapabilityLock(
      JSON.parse(await readFile(resolve(baselinePath), "utf8")),
    );
    let current;
    if (options.current) {
      current = parseCapabilityLock(
        JSON.parse(await readFile(resolve(options.current), "utf8")),
      );
    } else {
      const home = codexHome(options.codexHome);
      const scope = await commandProjectScope(home, options.project);
      current = await buildCapabilityLock({ codexHome: home, ...scope });
    }
    const report = compareCapabilityLocks(baseline, current);
    if (options.json) printJson(report);
    else {
      const { summary } = report;
      process.stdout.write(
        `CtxWise drift · ${report.status} · ${summary.total} changes (+${summary.added} -${summary.removed} ~${summary.changed}) · ${summary.bytesDelta >= 0 ? "+" : ""}${summary.bytesDelta.toLocaleString("en-US")} bytes\n`,
      );
      for (const change of report.changes)
        process.stdout.write(`${renderDriftChange(change)}\n`);
    }
    if (options.failOnDrift && report.status === "drifted") {
      process.exitCode = 2;
    }
  });

program
  .command("quota")
  .description(
    "Read the current Codex plan and quota window through local app-server",
  )
  .option("--codex-command <path>", "Codex executable", "codex")
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const invocation = await resolveCodexInvocation(options.codexCommand);
    const snapshot = await queryAccountSnapshot({
      command: invocation.command,
      commandPrefixArgs: invocation.prefixArgs,
    });
    if (options.json) printJson(snapshot);
    else
      process.stdout.write(
        `Plan ${snapshot.planType ?? "unknown"} · quota ${snapshot.quota ? `${snapshot.quota.usedPercent}% used` : "unknown"}\n`,
      );
  });

program
  .command("doctor")
  .description("Check local runtime and Codex executable availability")
  .option("--codex-command <path>", "Codex executable", "codex")
  .action(async (options) => {
    process.stdout.write(`Node ${process.version}: ok\n`);
    const invocation = await resolveCodexInvocation(options.codexCommand);
    await new Promise<void>((resolveDoctor) => {
      const child = spawn(
        invocation.command,
        [...invocation.prefixArgs, "--version"],
        {
          shell: false,
          windowsHide: true,
        },
      );
      let output = "";
      let settled = false;
      const finishDoctor = (message: string): void => {
        if (settled) return;
        settled = true;
        process.stdout.write(`${message}\n`);
        resolveDoctor();
      };
      child.stdout.on(
        "data",
        (chunk: Buffer | string) => (output += chunk.toString()),
      );
      child.on("error", (error) => {
        finishDoctor(`Codex: unavailable (${error.message})`);
      });
      child.on("close", (code) => {
        finishDoctor(
          code === 0
            ? `Codex ${output.trim()}: ok`
            : `Codex: unavailable (exit ${code ?? "unknown"})`,
        );
      });
    });
    const catalog = await loadPriceCatalog();
    process.stdout.write(`Price catalog ${catalog.effectiveDate}: ok\n`);
  });

program
  .command("codex-doctor")
  .description(
    "Audit OpenAI Codex AGENTS.override.md / AGENTS.md hierarchy against the 32 KiB truncation limit",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option(
    "--cwd <path>",
    "Working directory inside project to trace hierarchical chain",
  )
  .option(
    "--fail-on-issues",
    "Exit with status 2 when truncation, empty override shadowing, or config errors are found",
    false,
  )
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const workingDirectory = options.cwd
      ? resolve(options.cwd)
      : scope.workingDirectory;
    const report = await runCodexDoctor({
      codexHome: home,
      projectRoot: scope.projectRoot,
      workingDirectory,
    });
    if (options.json) printJson(report);
    else process.stdout.write(renderCodexDoctorReport(report));
    if (
      options.failOnIssues &&
      (report.status === "error" ||
        report.status === "truncated" ||
        report.findings.some((f) => f.code === "empty-override-shadows-agents"))
    ) {
      process.exitCode = 2;
    }
  });

program
  .command("agents")
  .description(
    "Audit startup context across Claude Code (CLAUDE.md), OpenAI Codex (AGENTS.md), and Cursor",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--claude-home <path>", "Claude home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const claudeDir = claudeHome(options.claudeHome);
    const report = await auditMultiAgentSurface({
      projectRoot: scope.projectRoot,
      codexHome: home,
      claudeHome: claudeDir,
    });
    if (options.json) printJson(report);
    else process.stdout.write(renderMultiAgentReport(report));
  });

program
  .command("sync")
  .description(
    "Synchronize and optionally compress instructions between AGENTS.md, CLAUDE.md, and Cursor rules",
  )
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .addOption(
    new Option("--from <source>", "Canonical source file")
      .choices(["auto", "agents", "claude"])
      .default("auto"),
  )
  .option(
    "--cursor",
    "Also generate .cursor/rules/ctxwise.mdc from the canonical instructions",
    false,
  )
  .option(
    "--compress",
    "Apply lossless markdown Token Diet (strip comments, duplicate bullets, and blank bloat)",
    false,
  )
  .option(
    "--dry-run",
    "Preview synchronized targets without writing files",
    false,
  )
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome();
    const scope = await commandProjectScope(home, options.project);
    const targets: SupportedAgentId[] = options.cursor
      ? ["claude", "codex", "cursor"]
      : ["claude", "codex"];
    const result = await syncAgentGuidance({
      projectRoot: scope.projectRoot,
      from: options.from as "auto" | "agents" | "claude",
      targets,
      compress: Boolean(options.compress),
      dryRun: Boolean(options.dryRun),
    });
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        `CtxWise sync · source ${result.sourcePath}${result.dryRun ? " (dry-run)" : ""}\n`,
      );
      for (const target of result.writtenTargets) {
        const savings =
          target.savedTokens > 0
            ? ` (saved ~${target.savedTokens.toLocaleString("en-US")} tokens)`
            : "";
        process.stdout.write(
          `- ${target.target}: ${target.path} (~${target.estimatedTokens.toLocaleString("en-US")} tokens)${savings}\n`,
        );
      }
    }
  });

program
  .command("mcp-xray")
  .description(
    "Profile MCP tool-schema token weights and identify bloated tools for tree-shaking",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--claude-home <path>", "Claude home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option(
    "--schema-file <path>",
    "Saved MCP tools/list JSON payload to analyze offline",
  )
  .option(
    "--probe-stdio",
    "Query declared local stdio MCP servers with tools/list",
    false,
  )
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const claudeDir = claudeHome(options.claudeHome);
    const declarations = await discoverMcpDeclarations({
      projectRoot: scope.projectRoot,
      codexHome: home,
      claudeHome: claudeDir,
    });
    const tools: McpToolSchemaMetric[] = [];
    if (options.schemaFile) {
      const payload = JSON.parse(
        await readFile(resolve(options.schemaFile), "utf8"),
      ) as unknown;
      tools.push(...analyzeMcpToolsPayload(payload, "schema-file"));
    }
    if (options.probeStdio) {
      for (const decl of declarations) {
        const probed = await probeStdioMcpServer(decl);
        tools.push(...probed);
      }
    }
    const report = buildMcpXrayReport({ declarations, tools });
    if (options.json) printJson(report);
    else process.stdout.write(renderMcpXrayReport(report));
  });

program
  .command("mcp-prune")
  .description(
    "Inspect or disable high-weight MCP servers in .mcp.json and .codex/config.toml with automatic .bak backups",
  )
  .option("--codex-home <path>", "Codex home directory")
  .option("--claude-home <path>", "Claude home directory")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option(
    "--disable <servers>",
    "Comma-separated or repeatable list of MCP server names to disable",
    collect,
    [],
  )
  .option(
    "--schema-file <path>",
    "Saved MCP tools/list JSON payload to analyze offline",
  )
  .option(
    "--probe-stdio",
    "Query declared local stdio MCP servers with tools/list",
    false,
  )
  .option(
    "--dry-run",
    "Preview configuration changes without modifying files",
    false,
  )
  .option("--no-backup", "Skip writing .bak backup files before pruning")
  .option("--json", "Print structured JSON", false)
  .action(async (options) => {
    const home = codexHome(options.codexHome);
    const scope = await commandProjectScope(home, options.project);
    const claudeDir = claudeHome(options.claudeHome);
    const declarations = await discoverMcpDeclarations({
      projectRoot: scope.projectRoot,
      codexHome: home,
      claudeHome: claudeDir,
    });
    const tools: McpToolSchemaMetric[] = [];
    if (options.schemaFile) {
      const payload = JSON.parse(
        await readFile(resolve(options.schemaFile), "utf8"),
      ) as unknown;
      tools.push(...analyzeMcpToolsPayload(payload, "schema-file"));
    }
    if (options.probeStdio) {
      for (const decl of declarations) {
        const probed = await probeStdioMcpServer(decl);
        tools.push(...probed);
      }
    }
    const report = await pruneMcpServers({
      projectRoot: scope.projectRoot,
      codexHome: home,
      claudeHome: claudeDir,
      disableServers: options.disable,
      tools,
      dryRun: Boolean(options.dryRun),
      backup: options.backup !== false,
    });
    if (options.json) printJson(report);
    else process.stdout.write(renderMcpPruneReport(report));
  });

program
  .command("shield")
  .description(
    "Scan agent context files (CLAUDE.md, AGENTS.md, skills, MCP configs) for leaked secrets and prompt injection",
  )
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--json", "Print structured JSON", false)
  .option(
    "--fail-on-risk",
    "Exit with status 2 when high or critical security risks are found",
    false,
  )
  .action(async (options) => {
    const home = codexHome();
    const scope = await commandProjectScope(home, options.project);
    const report = await runContextShield({ projectRoot: scope.projectRoot });
    if (options.json) printJson(report);
    else process.stdout.write(renderShieldReport(report));
    if (
      options.failOnRisk &&
      (report.summary.critical > 0 || report.summary.high > 0)
    ) {
      process.exitCode = 2;
    }
  });

program
  .command("preset")
  .description(
    "List or apply curated context budget and agent guidance presets for common stacks",
  )
  .argument("[name]", "Preset name to apply (omit to list available presets)")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option(
    "--with-guidance",
    "Also write starter AGENTS.md and CLAUDE.md files from the preset",
    false,
  )
  .option("--json", "Print structured JSON", false)
  .action(async (name: string | undefined, options) => {
    if (!name) {
      const presets = await listBuiltInPresets();
      if (options.json) printJson(presets);
      else {
        process.stdout.write(
          `CtxWise presets (${presets.length} available):\n`,
        );
        for (const preset of presets) {
          process.stdout.write(
            `- ${preset.name} (${preset.stack}) · <= ${preset.budget.maxKnownTokens.toLocaleString("en-US")} tokens — ${preset.description}\n`,
          );
        }
      }
      return;
    }
    const home = codexHome();
    const scope = await commandProjectScope(home, options.project);
    const applied = await applyPresetToProject({
      presetName: name,
      projectRoot: scope.projectRoot,
      writeGuidance: Boolean(options.withGuidance),
    });
    if (options.json) printJson(applied);
    else {
      process.stdout.write(
        `Applied preset ${applied.preset.name} -> ${applied.budgetPath}\n`,
      );
      for (const gPath of applied.guidancePaths) {
        process.stdout.write(`Wrote ${gPath}\n`);
      }
    }
  });

program
  .command("init")
  .description(
    "Initialize a project with a stack preset budget and starter AGENTS.md / CLAUDE.md guidance",
  )
  .argument("[preset]", "Preset name to apply")
  .option("--preset <name>", "Preset name to apply")
  .option("--project <path>", "Explicit project root; auto-detected by default")
  .option("--no-guidance", "Skip writing starter AGENTS.md and CLAUDE.md files")
  .option("--json", "Print structured JSON", false)
  .action(async (presetArg: string | undefined, options) => {
    const presetName = options.preset ?? presetArg ?? "nextjs-typescript";
    const home = codexHome();
    const scope = await commandProjectScope(home, options.project);
    const applied = await applyPresetToProject({
      presetName,
      projectRoot: scope.projectRoot,
      writeGuidance: options.guidance !== false,
    });
    if (options.json) printJson(applied);
    else {
      process.stdout.write(
        `Applied preset ${applied.preset.name} -> ${applied.budgetPath}\n`,
      );
      for (const gPath of applied.guidancePaths) {
        process.stdout.write(`Wrote ${gPath}\n`);
      }
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${pc.red("error:")} ${(error as Error).message}\n`);
  process.exitCode = 1;
});
