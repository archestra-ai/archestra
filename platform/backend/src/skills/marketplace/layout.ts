import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import logger from "@/logging";
import type { SkillFile } from "@/types";
import type { RevisionPayloadFile } from "@/types/skill-share-link-revision";
import {
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  buildSimpleMarketplaceManifest,
  buildSimplePluginManifest,
  type MarketplaceSkillInput,
  resolveMarketplaceSkills,
} from "./manifest";

/**
 * Pure layout builder: turns a `MaterializeRequest` into the flat list of
 * files that make up the marketplace git tree (`.claude-plugin/`, `.agents/`,
 * the single bundle plugin, and one `skills/<slug>/` directory per shared
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
}

export function computeLayout(req: MaterializeRequest): RevisionPayloadFile[] {
  const manifestSkills = req.skills.map<MarketplaceSkillInput>((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    updatedAt: skill.updatedAt,
  }));
  const resolved = resolveMarketplaceSkills(manifestSkills);

  const files: RevisionPayloadFile[] = [];

  // Claude Code and Cursor read byte-identical marketplace manifests; only
  // the path differs.
  const simpleMarketplaceJson = jsonStringify(
    buildSimpleMarketplaceManifest({
      marketplaceName: req.marketplaceName,
      ownerName: req.ownerName,
      skills: manifestSkills,
    }),
  );
  files.push(
    textFile(".claude-plugin/marketplace.json", simpleMarketplaceJson),
  );
  files.push(
    textFile(".cursor-plugin/marketplace.json", simpleMarketplaceJson),
  );
  files.push(
    textFile(
      ".agents/plugins/marketplace.json",
      jsonStringify(
        buildCodexMarketplaceManifest({
          marketplaceName: req.marketplaceName,
          displayName: req.displayName,
          skills: manifestSkills,
        }),
      ),
    ),
  );
  const pluginRoot = `plugins/${req.marketplaceName}`;
  const simplePluginJson = jsonStringify(
    buildSimplePluginManifest({
      marketplaceName: req.marketplaceName,
      ownerName: req.ownerName,
      skills: manifestSkills,
    }),
  );
  files.push(
    textFile(`${pluginRoot}/.claude-plugin/plugin.json`, simplePluginJson),
  );
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
      `${skillRoot}/SKILL.md`,
      buildSkillMarkdown(skill),
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

function buildSkillMarkdown(skill: MaterializeSkillInput): string {
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.license) frontmatter.license = skill.license;
  if (skill.compatibility) frontmatter.compatibility = skill.compatibility;
  if (skill.allowedTools) frontmatter["allowed-tools"] = skill.allowedTools;
  if (skill.templated) frontmatter.templated = true;
  if (skill.metadata && Object.keys(skill.metadata).length > 0) {
    frontmatter.metadata = skill.metadata;
  }

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
  if (relPath.startsWith("..") || relPath === "..") {
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
  // additional safety: reject any absolute or root-escape after normalization
  if (path.posix.isAbsolute(relPath) || relPath.includes("../")) {
    logger.warn(
      { path: file.path },
      "materialize: skipping file outside skill root",
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
