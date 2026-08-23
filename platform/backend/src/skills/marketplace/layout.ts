import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import logger from "@/logging";
import { SKILL_MANIFEST_FILENAME } from "@/skills/parser";
import type { SkillFile } from "@/types";
import type {
  ClientType,
  PluginFileEncoding,
  PluginFileMode,
} from "@/types/plugin";
import type { RevisionPayloadFile } from "@/types/skill-share-link-revision";
import {
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  buildCodexPluginMarketplaceEntry,
  buildCodexPluginPayloadManifest,
  buildPluginMarketplaceEntry,
  buildPluginPayloadManifest,
  buildSimpleMarketplaceManifest,
  buildSimplePluginManifest,
  type MarketplaceSkillInput,
  pluginManifestPath,
  resolveMarketplaceSkills,
  resolvePluginName,
  resolvePluginVersion,
} from "./manifest";

/**
 * Pure layout builder: turns a `MaterializeRequest` into the flat list of
 * files that make up the marketplace git tree (`.claude-plugin/`, `.agents/`,
 * the single plugin plugin, and one `skills/<slug>/` directory per shared
 * skill with its SKILL.md + resource files).
 *
 * Output is consumed both by the content-hash dedupe and the on-disk commit
 * step in `materialize.ts`. Doing this purely (no I/O) lets us hash the
 * desired tree before deciding whether a commit is needed.
 */

export interface MaterializeSkillInput {
  id: string;
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  agentName: string | null;
  templated: boolean;
  metadata: Record<string, string>;
  updatedAt: Date;
  files: SkillFile[];
}

export interface MaterializeRequest {
  linkId: string;
  marketplaceName: string;
  ownerName: string;
  displayName: string;
  skills: MaterializeSkillInput[];
  plugins?: MaterializePluginInput[];
}

export interface MaterializePluginInput {
  pluginSlug: string;
  displayName: string;
  description: string;
  clientType: ClientType;
  files: Array<{
    path: string;
    content: string;
    encoding: PluginFileEncoding;
    mode: PluginFileMode;
  }>;
}

export function computeLayout(
  req: MaterializeRequest,
  revisionSequence: number,
): RevisionPayloadFile[] {
  const manifestSkills = req.skills.map<MarketplaceSkillInput>((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    updatedAt: skill.updatedAt,
  }));
  const resolved = resolveMarketplaceSkills(manifestSkills);
  const version = resolvePluginVersion(revisionSequence);
  const plugins = [...(req.plugins ?? [])].sort((a, b) =>
    a.pluginSlug.localeCompare(b.pluginSlug),
  );

  const files: RevisionPayloadFile[] = [];

  // Claude Code and Cursor read byte-identical marketplace manifests; only
  // the path differs.
  const simpleMarketplace = buildSimpleMarketplaceManifest({
    marketplaceName: req.marketplaceName,
    ownerName: req.ownerName,
    skills: manifestSkills,
    version,
  });
  const claudeMarketplace = {
    ...simpleMarketplace,
    plugins: [...simpleMarketplace.plugins],
  };
  const cursorMarketplace = {
    ...simpleMarketplace,
    plugins: [...simpleMarketplace.plugins],
  };
  const codexMarketplace = buildCodexMarketplaceManifest({
    marketplaceName: req.marketplaceName,
    displayName: req.displayName,
    skills: manifestSkills,
    version,
  });

  for (const plugin of plugins) {
    const pluginName = resolvePluginName(plugin.pluginSlug);
    const simpleEntry = buildPluginMarketplaceEntry({
      pluginName,
      description: plugin.description,
      version,
    });
    if (plugin.clientType === "claude-code") {
      claudeMarketplace.plugins.push(simpleEntry);
    } else if (plugin.clientType === "cursor") {
      cursorMarketplace.plugins.push(simpleEntry);
    } else if (plugin.clientType === "codex") {
      codexMarketplace.plugins.push(
        buildCodexPluginMarketplaceEntry({
          pluginName,
          description: plugin.description,
          version,
        }),
      );
    }
  }

  files.push(
    textFile(
      ".claude-plugin/marketplace.json",
      jsonStringify(claudeMarketplace),
    ),
  );
  files.push(
    textFile(
      ".cursor-plugin/marketplace.json",
      jsonStringify(cursorMarketplace),
    ),
  );
  files.push(
    textFile(
      ".agents/plugins/marketplace.json",
      jsonStringify(codexMarketplace),
    ),
  );
  const copilotPlugins = plugins.filter(
    (plugin) => plugin.clientType === "copilot-cli",
  );
  files.push(
    textFile(
      ".github/plugin/marketplace.json",
      jsonStringify({
        ...simpleMarketplace,
        plugins: [
          ...simpleMarketplace.plugins,
          ...copilotPlugins.map((plugin) =>
            buildPluginMarketplaceEntry({
              pluginName: resolvePluginName(plugin.pluginSlug),
              description: plugin.description,
              version,
            }),
          ),
        ],
      }),
    ),
  );
  const pluginRoot = `plugins/${req.marketplaceName}`;
  const simplePluginJson = jsonStringify(
    buildSimplePluginManifest({
      marketplaceName: req.marketplaceName,
      ownerName: req.ownerName,
      skills: manifestSkills,
      version,
    }),
  );
  files.push(
    textFile(`${pluginRoot}/.claude-plugin/plugin.json`, simplePluginJson),
  );
  files.push(textFile(`${pluginRoot}/plugin.json`, simplePluginJson));

  for (const plugin of plugins) {
    const pluginName = resolvePluginName(plugin.pluginSlug);
    const pluginRoot = `plugins/${pluginName}`;
    const manifestPath = pluginManifestPath(plugin.clientType);
    const manifest =
      plugin.clientType === "codex"
        ? buildCodexPluginPayloadManifest({
            pluginName,
            displayName: plugin.displayName,
            description: plugin.description,
            version,
          })
        : buildPluginPayloadManifest({
            pluginName,
            description: plugin.description,
            version,
          });
    const sourceProvidesManifest = plugin.files.some(
      (file) => file.path.toLowerCase() === manifestPath.toLowerCase(),
    );
    if (!sourceProvidesManifest) {
      files.push(
        textFile(`${pluginRoot}/${manifestPath}`, jsonStringify(manifest)),
      );
    }

    const seenPluginPaths = new Set<string>();
    if (!sourceProvidesManifest) {
      seenPluginPaths.add(manifestPath.toLowerCase());
    }
    for (const file of plugin.files) {
      const resolvedFile = resolvePluginFile({ file, pluginRoot });
      if (!resolvedFile) continue;
      const relativeLower = resolvedFile.path
        .slice(pluginRoot.length + 1)
        .toLowerCase();
      if (seenPluginPaths.has(relativeLower)) {
        logger.warn(
          { path: resolvedFile.path },
          "materialize: skipping plugin file with path collision",
        );
        continue;
      }
      seenPluginPaths.add(relativeLower);
      files.push(resolvedFile);
    }
  }
  files.push(
    textFile(`${pluginRoot}/.cursor-plugin/plugin.json`, simplePluginJson),
  );
  files.push(
    textFile(
      `${pluginRoot}/.codex-plugin/plugin.json`,
      jsonStringify(
        buildCodexPluginManifest({
          marketplaceName: req.marketplaceName,
          displayName: req.displayName,
          skills: manifestSkills,
          version,
        }),
      ),
    ),
  );
  const skillById = new Map(req.skills.map((s) => [s.id, s]));
  // Guard against two files whose paths differ only in case: on a
  // case-insensitive filesystem the second write would silently overwrite the
  // first, making the commit SHA depend on host case-sensitivity and breaking
  // byte-identical replay. Drop later collisions so the tree is unambiguous.
  const seenLowerPaths = new Set<string>();
  for (const { id, slug } of resolved) {
    const skill = skillById.get(id);
    if (!skill) continue;

    const skillRoot = `${pluginRoot}/skills/${slug}`;
    const skillMd = textFile(
      `${skillRoot}/${SKILL_MANIFEST_FILENAME}`,
      buildSkillMarkdown(skill, slug),
    );
    files.push(skillMd);
    seenLowerPaths.add(skillMd.path.toLowerCase());

    for (const file of skill.files) {
      const resolvedFile = resolveResourceFile({ file, skillRoot });
      if (!resolvedFile) continue;
      const lowerPath = resolvedFile.path.toLowerCase();
      if (seenLowerPaths.has(lowerPath)) {
        logger.warn(
          { path: resolvedFile.path },
          "materialize: skipping resource file with case-insensitive path collision",
        );
        continue;
      }
      seenLowerPaths.add(lowerPath);
      files.push(resolvedFile);
    }
  }

  return files;
}

// ===== Internal helpers =====

function textFile(filePath: string, content: string): RevisionPayloadFile {
  return { path: filePath, mode: "100644", encoding: "utf8", content };
}

function jsonStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildSkillMarkdown(
  skill: MaterializeSkillInput,
  slug: string,
): string {
  // The Agent Skills spec requires frontmatter `name` to be a kebab slug that
  // equals the parent directory name — clients derive the slash command from
  // it, so the display name (which may contain spaces) must not leak here.
  const frontmatter: Record<string, unknown> = {
    name: slug,
    description: skill.description,
  };
  if (skill.license) frontmatter.license = skill.license;
  if (skill.compatibility) frontmatter.compatibility = skill.compatibility;
  if (skill.allowedTools) frontmatter["allowed-tools"] = skill.allowedTools;
  if (skill.agentName) frontmatter.agent = skill.agentName;
  if (skill.templated) frontmatter.templated = true;
  frontmatter.metadata = { displayName: skill.name, ...skill.metadata };

  const yamlBody = dumpYaml(frontmatter, {
    sortKeys: false,
    lineWidth: -1,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
  });

  const body = skill.content.trim();
  return `---\n${yamlBody}---\n\n${body}\n`;
}

function resolveResourceFile(params: {
  file: SkillFile;
  skillRoot: string;
}): RevisionPayloadFile | null {
  const { file, skillRoot } = params;

  if (file.path.includes("\0")) {
    logger.warn(
      { path: file.path },
      "materialize: skipping file with null byte in path",
    );
    return null;
  }
  const relPath = path.posix.normalize(file.path.replace(/^\.?\//, ""));
  // Reject absolute paths and any `..` traversal *segment*. A substring test
  // (startsWith("..") / includes("../")) also drops legitimate names that merely
  // begin with or contain dots, e.g. a "notes.." folder, silently losing the
  // file — so match whole segments. Split on both separators so a Windows-style
  // "..\\evil.md" (which materialize.ts later re-splits) is still rejected, not
  // just POSIX "../"; mirrors the intent of SkillFileInputSchema in ../validation.ts.
  if (
    path.posix.isAbsolute(relPath) ||
    relPath.split(/[/\\]/).some((segment) => segment === "..")
  ) {
    logger.warn(
      { path: file.path },
      "materialize: skipping file with traversal path",
    );
    return null;
  }
  // case-insensitive: collides with the generated SKILL.md on macOS APFS and
  // Windows NTFS, where the second writeFile would silently overwrite the first
  const relLower = relPath.toLowerCase();
  if (relLower === "skill.md" || relLower.startsWith("skill.md/")) {
    logger.warn(
      { path: file.path },
      "materialize: skipping reserved resource path SKILL.md",
    );
    return null;
  }

  return {
    path: `${skillRoot}/${relPath}`,
    mode: "100644",
    encoding: file.encoding === "base64" ? "base64" : "utf8",
    content: file.content,
  };
}

function resolvePluginFile(params: {
  file: MaterializePluginInput["files"][number];
  pluginRoot: string;
}): RevisionPayloadFile | null {
  const { file, pluginRoot } = params;
  if (file.path.includes("\0") || file.path.includes("\\")) {
    logger.warn(
      { path: file.path },
      "materialize: skipping plugin file with unsafe path",
    );
    return null;
  }
  const relPath = path.posix.normalize(file.path.replace(/^\.\//, ""));
  if (
    path.posix.isAbsolute(relPath) ||
    relPath === "." ||
    relPath.split("/").some((segment) => segment === "..")
  ) {
    logger.warn(
      { path: file.path },
      "materialize: skipping plugin file with traversal path",
    );
    return null;
  }
  return {
    path: `${pluginRoot}/${relPath}`,
    mode: file.mode,
    encoding: file.encoding,
    content: file.content,
  };
}
