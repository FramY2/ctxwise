import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import process from "node:process";

export interface CodexInvocation {
  command: string;
  prefixArgs: string[];
  source: "explicit" | "npm-launcher" | "path";
}

interface ResolveCodexOptions {
  env?: Record<string, string | undefined>;
  fileExists?: (path: string) => Promise<boolean>;
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function npmLauncherCandidates(
  env: Record<string, string | undefined>,
): string[] {
  const roots = new Set<string>();
  if (env.APPDATA) roots.add(join(env.APPDATA, "npm"));
  if (env.npm_config_prefix) roots.add(env.npm_config_prefix);
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry.trim()) roots.add(entry.trim());
  }
  return [...roots].map((root) =>
    join(root, "node_modules", "@openai", "codex", "bin", "codex.js"),
  );
}

export async function resolveCodexInvocation(
  requestedCommand = "codex",
  options: ResolveCodexOptions = {},
): Promise<CodexInvocation> {
  if (requestedCommand !== "codex") {
    return {
      command: requestedCommand,
      prefixArgs: [],
      source: "explicit",
    };
  }

  const env = options.env ?? process.env;
  const configured = env.CTXWISE_CODEX_BIN ?? env.CTXRAY_CODEX_BIN;
  if (configured) {
    return { command: configured, prefixArgs: [], source: "explicit" };
  }

  if ((options.platform ?? process.platform) === "win32") {
    const fileExists = options.fileExists ?? defaultFileExists;
    for (const launcher of npmLauncherCandidates(env)) {
      if (await fileExists(launcher)) {
        return {
          command: options.nodeExecutable ?? process.execPath,
          prefixArgs: [launcher],
          source: "npm-launcher",
        };
      }
    }
  }

  return { command: requestedCommand, prefixArgs: [], source: "path" };
}

/**
 * A command line that is safe to hand to `child_process.spawn` with
 * `shell: false`. On Windows, `.cmd` / `.bat` shims (npm, npx, pnpm, yarn,
 * corepack, globally installed npm bins) cannot be spawned without `cmd.exe`,
 * so they are rewritten to `node <entry-script>` or to the native `.exe` the
 * shim points at. The shim itself is only *read* from disk, never executed.
 */
export interface SpawnInvocation {
  command: string;
  args: string[];
  source: "passthrough" | "native" | "node-script" | "cmd-shim" | "unresolved";
}

export interface ResolveSpawnOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  fileExists?: (path: string) => Promise<boolean>;
  readTextFile?: (path: string) => Promise<string>;
}

const NODE_SCRIPT_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const NATIVE_EXTENSIONS = [".exe", ".com"];
const SHIM_EXTENSIONS = [".cmd", ".bat"];

/** Entry scripts bundled next to `node.exe` for the Node-distributed package managers. */
const NODE_BUNDLED_ENTRY_SCRIPTS: Record<string, string[]> = {
  npm: ["node_modules", "npm", "bin", "npm-cli.js"],
  npx: ["node_modules", "npm", "bin", "npx-cli.js"],
  corepack: ["node_modules", "corepack", "dist", "corepack.js"],
  pnpm: ["node_modules", "corepack", "dist", "pnpm.js"],
  pnpx: ["node_modules", "corepack", "dist", "pnpx.js"],
  yarn: ["node_modules", "corepack", "dist", "yarn.js"],
  yarnpkg: ["node_modules", "corepack", "dist", "yarnpkg.js"],
};
const PREFER_BUNDLED = new Set(["npm", "npx", "corepack"]);

async function defaultIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function lookupEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("\\") || command.includes("/");
}

/**
 * Extract the target that an npm `cmd-shim` / Node-distributed `.cmd` launcher
 * runs, by statically reading the batch file. Only paths anchored at the shim
 * directory (`%~dp0` / `%dp0%`) are honoured, so arbitrary batch logic is never
 * interpreted or executed.
 */
export function parseCmdShimTargets(
  shimContent: string,
  shimPath: string,
): string[] {
  const shimDir = win32.dirname(shimPath);
  const pattern =
    /"(?:[A-Za-z_][\w]*=)?(?:%~dp0|%dp0%)\\?([^"%\r\n]+?\.(?:cjs|mjs|js|exe|com))"/gi;
  const targets: string[] = [];
  for (const match of shimContent.matchAll(pattern)) {
    const relative = match[1];
    if (!relative) continue;
    const absolute = win32.resolve(shimDir, relative);
    if (win32.basename(absolute).toLowerCase() === "node.exe") continue;
    if (!targets.includes(absolute)) targets.push(absolute);
  }
  return targets;
}

function pickShimTarget(targets: string[], commandName: string): string | null {
  if (targets.length === 0) return null;
  const name = commandName.toLowerCase();
  const named = targets.filter((target) => {
    const base = win32.basename(target).toLowerCase();
    return (
      base === name ||
      base.startsWith(`${name}.`) ||
      base.startsWith(`${name}-`)
    );
  });
  return (named.length > 0 ? named : targets).at(-1) ?? null;
}

async function resolveFromShim(
  shimPath: string,
  args: string[],
  nodeExecutable: string,
  fileExists: (path: string) => Promise<boolean>,
  readTextFile: (path: string) => Promise<string>,
): Promise<SpawnInvocation | null> {
  let content: string;
  try {
    content = await readTextFile(shimPath);
  } catch {
    return null;
  }
  const commandName = win32.basename(shimPath, win32.extname(shimPath));
  const candidates = parseCmdShimTargets(content, shimPath);
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) existing.push(candidate);
  }
  const target = pickShimTarget(existing, commandName);
  if (!target) return null;
  const extension = win32.extname(target).toLowerCase();
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return {
      command: nodeExecutable,
      args: [target, ...args],
      source: "cmd-shim",
    };
  }
  return { command: target, args: [...args], source: "cmd-shim" };
}

async function resolveWindowsFile(
  filePath: string,
  args: string[],
  nodeExecutable: string,
  fileExists: (path: string) => Promise<boolean>,
  readTextFile: (path: string) => Promise<string>,
): Promise<SpawnInvocation | null> {
  const extension = win32.extname(filePath).toLowerCase();
  if (NATIVE_EXTENSIONS.includes(extension)) {
    return (await fileExists(filePath))
      ? { command: filePath, args: [...args], source: "native" }
      : null;
  }
  if (NODE_SCRIPT_EXTENSIONS.has(extension)) {
    return (await fileExists(filePath))
      ? {
          command: nodeExecutable,
          args: [filePath, ...args],
          source: "node-script",
        }
      : null;
  }
  if (SHIM_EXTENSIONS.includes(extension)) {
    return (await fileExists(filePath))
      ? resolveFromShim(
          filePath,
          args,
          nodeExecutable,
          fileExists,
          readTextFile,
        )
      : null;
  }
  for (const candidateExtension of [...NATIVE_EXTENSIONS, ...SHIM_EXTENSIONS]) {
    const resolved = await resolveWindowsFile(
      `${filePath}${candidateExtension}`,
      args,
      nodeExecutable,
      fileExists,
      readTextFile,
    );
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolve an MCP / tool command into a `shell: false`-safe spawn invocation.
 *
 * - Non-Windows platforms: returned unchanged (`execvp` handles `PATH`).
 * - Windows: `npm`/`npx`/`corepack`/`pnpm`/`yarn` map to the entry script
 *   bundled next to `node.exe`; otherwise `PATH` is searched for
 *   `<cmd>.exe` / `<cmd>.com` (spawned directly) or `<cmd>.cmd` / `<cmd>.bat`
 *   shims, which are statically parsed for their `.js`/`.cjs`/`.mjs`/`.exe`
 *   target. `cmd.exe` is never involved; unresolvable commands are reported as
 *   `unresolved` so callers can fail closed.
 */
export async function resolveSpawnInvocation(
  command: string,
  args: string[] = [],
  options: ResolveSpawnOptions = {},
): Promise<SpawnInvocation> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args: [...args], source: "passthrough" };
  }

  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultIsFile;
  const readTextFile =
    options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();
  const trimmed = command.trim();

  if (win32.isAbsolute(trimmed) || hasPathSeparator(trimmed)) {
    const resolved = await resolveWindowsFile(
      win32.resolve(cwd, trimmed),
      args,
      nodeExecutable,
      fileExists,
      readTextFile,
    );
    return resolved ?? { command, args: [...args], source: "unresolved" };
  }

  const extension = win32.extname(trimmed).toLowerCase();
  const knownExtension =
    NATIVE_EXTENSIONS.includes(extension) ||
    SHIM_EXTENSIONS.includes(extension) ||
    NODE_SCRIPT_EXTENSIONS.has(extension);
  const bareName = (
    knownExtension ? trimmed.slice(0, -extension.length) : trimmed
  ).toLowerCase();

  if (bareName === "node" && (!knownExtension || extension === ".exe")) {
    return { command: nodeExecutable, args: [...args], source: "native" };
  }

  const bundled = NODE_BUNDLED_ENTRY_SCRIPTS[bareName];
  const bundledEligible =
    bundled !== undefined &&
    (!knownExtension || SHIM_EXTENSIONS.includes(extension));
  const resolveBundled = async (): Promise<SpawnInvocation | null> => {
    if (!bundled || !bundledEligible) return null;
    const script = win32.join(win32.dirname(nodeExecutable), ...bundled);
    return (await fileExists(script))
      ? {
          command: nodeExecutable,
          args: [script, ...args],
          source: "node-script",
        }
      : null;
  };

  // npm/npx/corepack ship inside the Node install: trust that copy first.
  if (PREFER_BUNDLED.has(bareName)) {
    const resolved = await resolveBundled();
    if (resolved) return resolved;
  }

  // The current directory is deliberately NOT searched: a repository must not
  // be able to shadow `npx` or `uvx` with a planted executable.
  const searchDirs = (lookupEnv(env, "PATH") ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of searchDirs) {
    const resolved = await resolveWindowsFile(
      win32.join(dir, trimmed),
      args,
      nodeExecutable,
      fileExists,
      readTextFile,
    );
    if (resolved) return resolved;
  }

  // pnpm/yarn: fall back to the Corepack entry points bundled with Node.
  const fallback = await resolveBundled();
  if (fallback) return fallback;

  return { command, args: [...args], source: "unresolved" };
}
