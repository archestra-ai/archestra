/**
 * Pure presentation helpers for a skill's version history: how versions are
 * bucketed in the timeline, and which Monaco language a file's path implies.
 *
 * Kept out of the dialog so both are readable on their own — neither depends on
 * any of the history's loading, selection, or diff state.
 */

import { format } from "date-fns";
import type { SkillVersionSummary } from "@/lib/skills/skill.query";

export interface SkillVersionDayGroup {
  label: string;
  versions: SkillVersionSummary[];
}

/**
 * Bucket versions by the day they were created, preserving the order they
 * arrive in. The list is newest-first, so the groups come out that way too, and
 * runs are collapsed by comparing against the last group rather than by sorting
 * — a version out of order would start its own group instead of being silently
 * folded into a day it does not belong to.
 */
export function groupVersionsByDay(
  versions: SkillVersionSummary[],
): SkillVersionDayGroup[] {
  const groups: SkillVersionDayGroup[] = [];
  for (const version of versions) {
    const label = format(new Date(version.createdAt), "MMM d, yyyy");
    const current = groups.at(-1);
    if (current?.label === label) {
      current.versions.push(version);
    } else {
      groups.push({ label, versions: [version] });
    }
  }
  return groups;
}

/**
 * The Monaco language for a resource file, taken from its extension. Anything
 * unrecognised reads as plain text rather than guessing — a wrong language
 * highlights a file as something it is not.
 */
export function languageForPath(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return LANGUAGES_BY_EXTENSION[extension] ?? "plaintext";
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  css: "css",
  csv: "plaintext",
  html: "html",
  js: "javascript",
  json: "json",
  jsonl: "json",
  md: "markdown",
  py: "python",
  sh: "shell",
  toml: "ini",
  ts: "typescript",
  txt: "plaintext",
  yaml: "yaml",
  yml: "yaml",
};
