import {
  type CompactSkillIndex,
  decodeSkillIndex,
  type SkillIndexEntry,
} from "./skill-index";
import generatedSkillIndex from "./skill-index.generated.json";

// this module owns the large generated index; import it dynamically
// (`import("./skill-index-data")`) so the JSON stays out of the initial
// client bundle and is fetched only when a user actually searches.
const entries: readonly SkillIndexEntry[] = decodeSkillIndex(
  generatedSkillIndex as unknown as CompactSkillIndex,
);

export const SKILL_INDEX_ENTRIES = entries;
export const SKILL_INDEX_ENTRY_COUNT = entries.length;
