import path from "node:path";
import { dump as dumpYaml } from "js-yaml";
import logger from "@/logging";
import type { SkillFile } from "@/types";
import type { RevisionPayloadFile } from "@/types/skill-share-link-revision";
import {
  buildClaudeMarketplaceManifest,
  buildClaudePluginManifest,
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  type MarketplaceSkillInput,
  resolveMarketplaceSkills,
} from "./manifest";

/**
 * Pure layout builder: turns a `MaterializeRequest` into the flat list of
 * files that make up the marketplace git tree (`.claude-plugin/`, `.agents/`,
 * per-skill plugin manifests, SKILL.md, and user resource files).
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
  metadata: Record<string, string>;
  version?: string | null;
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
  const resolved = resolveMarketplaceSkills(
    req.skills.map<MarketplaceSkillInput>((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      updatedAt: skill.updatedAt,
    })),
  );

  const files: RevisionPayloadFile[] = [];

  files.push(
    textFile(
      ".claude-plugin/marketplace.json",
      jsonStringify(
        buildClaudeMarketplaceManifest({
          marketplaceName: req.marketplaceName,
          ownerName: req.ownerName,
          skills: resolved,
        }),
      ),
    ),
  );
  files.push(
    textFile(
      ".agents/plugins/marketplace.json",
      jsonStringify(
        buildCodexMarketplaceManifest({
          marketplaceName: req.marketplaceName,
          displayName: req.displayName,
          skills: resolved,
        }),
      ),
    ),
  );

  const skillById = new Map(req.skills.map((s) => [s.id, s]));
  for (const { id, slug } of resolved) {
    const skill = skillById.get(id);
    if (!skill) continue;

    const skillInput: MarketplaceSkillInput = {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      updatedAt: skill.updatedAt,
    };

    files.push(
      textFile(
        `plugins/${slug}/.claude-plugin/plugin.json`,
        jsonStringify(buildClaudePluginManifest({ skill: skillInput, slug })),
      ),
    );
    files.push(
      textFile(
        `plugins/${slug}/.codex-plugin/plugin.json`,
        jsonStringify(buildCodexPluginManifest({ skill: skillInput, slug })),
      ),
    );
    files.push(
      textFile(
        `plugins/${slug}/skills/${slug}/SKILL.md`,
        buildSkillMarkdown(skill),
      ),
    );

    const skillRoot = `plugins/${slug}/skills/${slug}`;
    for (const file of skill.files) {
      const resolvedFile = resolveResourceFile({ file, skillRoot });
      if (resolvedFile) files.push(resolvedFile);
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
  if (relPath === "SKILL.md" || relPath.startsWith("SKILL.md/")) {
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
