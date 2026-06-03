import logger from "@/logging";
import generatedCatalog from "./skill-catalog.generated.json";
import {
  buildSkillCatalogIndex,
  type CompactSkillCatalog,
  decodeSkillCatalog,
  type SkillCatalogEntry,
  type SkillCatalogSearchIndex,
  searchSkillCatalogIndex,
} from "./skill-catalog-index";

/**
 * Process-wide search over the crawled public-GitHub skill catalog (the
 * `skill-catalog.generated.json` produced by
 * standalone-scripts/generate-skill-index.ts). The decoded entries and the
 * inverted index are built lazily on the first query and then reused for the
 * life of the process: the catalog is a static, redeploy-time asset, so there
 * is nothing to invalidate.
 */
class SkillCatalogService {
  private index: SkillCatalogSearchIndex | null = null;

  search(params: { query: string; limit?: number }): SkillCatalogEntry[] {
    return searchSkillCatalogIndex(this.getIndex(), params.query, params.limit);
  }

  get size(): number {
    return this.getIndex().entries.length;
  }

  private getIndex(): SkillCatalogSearchIndex {
    if (this.index) return this.index;
    const entries = decodeSkillCatalog(
      generatedCatalog as unknown as CompactSkillCatalog,
    );
    this.index = buildSkillCatalogIndex(entries);
    logger.info(
      { skillCount: entries.length, tokenCount: this.index.tokens.length },
      "[SkillCatalog] Built in-memory skill catalog search index",
    );
    return this.index;
  }
}

export const skillCatalog = new SkillCatalogService();
