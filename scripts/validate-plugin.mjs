import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(message) {
  errors.push(message);
}

async function readText(relativePath) {
  try {
    return await readFile(path.join(root, relativePath), "utf8");
  } catch (error) {
    fail(
      `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

async function readJson(relativePath) {
  const text = await readText(relativePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(
      `${relativePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

async function isDirectory(absolutePath) {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label}: expected a non-empty string`);
    return "";
  }
  return value;
}

function parseFrontmatter(text, label) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) {
    fail(`${label}: missing YAML frontmatter`);
    return undefined;
  }
  try {
    return parseYaml(match[1]);
  } catch (error) {
    fail(
      `${label}: invalid frontmatter (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

const marketplacePath = ".agents/plugins/marketplace.json";
const packageMetadata = await readJson("package.json");
const marketplace = await readJson(marketplacePath);
let skillCount = 0;

if (marketplace) {
  requireString(marketplace.name, `${marketplacePath} name`);
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    fail(`${marketplacePath}: plugins must be a non-empty array`);
  } else {
    for (const entry of marketplace.plugins) {
      const pluginName = requireString(
        entry?.name,
        `${marketplacePath} plugin name`,
      );
      const sourcePath = requireString(
        entry?.source?.path,
        `${marketplacePath} ${pluginName || "plugin"} source.path`,
      );
      if (entry?.source?.source !== "local") {
        fail(`${marketplacePath} ${pluginName}: source.source must be "local"`);
      }
      if (entry?.policy?.installation !== "AVAILABLE") {
        fail(
          `${marketplacePath} ${pluginName}: installation policy must be AVAILABLE`,
        );
      }
      requireString(
        entry?.category,
        `${marketplacePath} ${pluginName} category`,
      );
      if (!sourcePath) continue;

      const pluginDirectory = path.resolve(root, sourcePath);
      if (!pluginDirectory.startsWith(`${root}${path.sep}`)) {
        fail(`${marketplacePath} ${pluginName}: source escapes the repository`);
        continue;
      }
      if (!(await isDirectory(pluginDirectory))) {
        fail(
          `${marketplacePath} ${pluginName}: source directory does not exist`,
        );
        continue;
      }

      const manifestRelative = path.relative(
        root,
        path.join(pluginDirectory, ".codex-plugin", "plugin.json"),
      );
      const manifest = await readJson(manifestRelative);
      if (!manifest) continue;

      if (
        manifest.name !== pluginName ||
        manifest.name !== path.basename(pluginDirectory)
      ) {
        fail(
          `${manifestRelative}: name must match marketplace entry and plugin directory`,
        );
      }
      if (
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
          manifest.version ?? "",
        )
      ) {
        fail(`${manifestRelative}: version must be valid SemVer`);
      }
      if (packageMetadata && manifest.version !== packageMetadata.version) {
        fail(`${manifestRelative}: version must match package.json`);
      }
      requireString(manifest.description, `${manifestRelative} description`);
      requireString(manifest.license, `${manifestRelative} license`);

      const prompts = manifest.interface?.defaultPrompt;
      if (
        !Array.isArray(prompts) ||
        prompts.length === 0 ||
        prompts.length > 3
      ) {
        fail(
          `${manifestRelative}: interface.defaultPrompt must contain one to three prompts`,
        );
      } else if (
        prompts.some(
          (prompt) => typeof prompt !== "string" || prompt.length > 128,
        )
      ) {
        fail(
          `${manifestRelative}: default prompts must be strings of at most 128 characters`,
        );
      }

      const skillsSetting = requireString(
        manifest.skills,
        `${manifestRelative} skills`,
      );
      const skillsDirectory = path.resolve(
        pluginDirectory,
        skillsSetting || "skills",
      );
      if (!(await isDirectory(skillsDirectory))) {
        fail(`${manifestRelative}: skills directory does not exist`);
        continue;
      }

      for (const item of await readdir(skillsDirectory, {
        withFileTypes: true,
      })) {
        if (!item.isDirectory()) continue;
        const skillDirectory = path.join(skillsDirectory, item.name);
        const skillRelative = path.relative(
          root,
          path.join(skillDirectory, "SKILL.md"),
        );
        const skillText = await readText(skillRelative);
        if (!skillText) continue;
        skillCount += 1;

        const frontmatter = parseFrontmatter(skillText, skillRelative);
        if (frontmatter) {
          if (frontmatter.name !== item.name) {
            fail(`${skillRelative}: frontmatter name must match its directory`);
          }
          const description = requireString(
            frontmatter.description,
            `${skillRelative} description`,
          );
          if (description.length > 1024) {
            fail(`${skillRelative}: description exceeds 1024 characters`);
          }
        }

        const agentRelative = path.relative(
          root,
          path.join(skillDirectory, "agents", "openai.yaml"),
        );
        const agentText = await readText(agentRelative);
        if (agentText) {
          try {
            const agent = parseYaml(agentText);
            requireString(
              agent?.interface?.display_name,
              `${agentRelative} display_name`,
            );
            const defaultPrompt = requireString(
              agent?.interface?.default_prompt,
              `${agentRelative} default_prompt`,
            );
            if (defaultPrompt && !defaultPrompt.includes(`$${item.name}`)) {
              fail(
                `${agentRelative}: default_prompt must explicitly reference $${item.name}`,
              );
            }
            if (agent?.policy?.allow_implicit_invocation !== false) {
              fail(
                `${agentRelative}: CtxWise must remain explicit-invocation only`,
              );
            }
          } catch (error) {
            fail(
              `${agentRelative}: invalid YAML (${error instanceof Error ? error.message : String(error)})`,
            );
          }
        }

        if (/\b(?:TODO|FIXME|CHANGEME)\b/i.test(skillText + agentText)) {
          fail(`${skillRelative}: unresolved placeholder marker`);
        }
        const topLevelSkillRelative = path.join(
          "skills",
          item.name,
          "SKILL.md",
        );
        const topLevelSkillText = await readText(topLevelSkillRelative);
        if (topLevelSkillText && topLevelSkillText !== skillText) {
          fail(
            `${topLevelSkillRelative}: must stay identical to ${skillRelative}`,
          );
        }
      }
    }
  }
}

if (skillCount === 0) {
  fail("No plugin skills were discovered");
}

if (errors.length > 0) {
  console.error("CtxWise plugin validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `CtxWise plugin validation passed: ${marketplace.plugins.length} plugin, ${skillCount} skill.`,
  );
}
