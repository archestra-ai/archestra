import {
  describeUnusableSkillName,
  isSpecCompliantSkillName,
} from "@archestra/shared";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

/**
 * Why the name in the form cannot be saved, in one sentence to show under the
 * field before the save is tried: it cannot be a folder name, or the same
 * author already has a skill by that name in any letter case.
 *
 * Asked only of a name that is new to the skill, like the API's own check. A
 * skill stored under a name this would refuse (an older row, a Git import)
 * shows nothing until the name is edited, so its other fields stay saveable.
 *
 * The duplicate check is a courtesy: it looks through the skills the reader
 * can see, and the API decides. A save can still be refused for a skill this
 * reader cannot see, and the toast reports that.
 */
export function useSkillNameProblem({
  name,
  originalName,
  ownerId,
  skillId,
}: {
  /** The name in the draft; null when the manifest has none. */
  name: string | null;
  /** The stored name; null for a skill being created. */
  originalName: string | null;
  /** Whose skills a name must be unique among: the author. */
  ownerId: string | null | undefined;
  /** The skill being edited, which is not its own duplicate. */
  skillId?: string;
}): string | null {
  const trimmed = name?.trim() ?? "";
  const isNewName = trimmed !== "" && trimmed !== originalName;
  const unusable = isNewName ? describeUnusableSkillName(trimmed) : null;

  const searched = useDebouncedValue(trimmed, NAME_LOOKUP_DELAY_MS);
  const { data } = useSkillsPaginated(
    { search: searched, limit: 100, offset: 0, includeContent: false },
    {
      enabled: isNewName && !unusable && !!ownerId && searched !== "",
      toastOnError: false,
    },
  );

  if (!isNewName) return null;
  if (unusable) return unusable;

  // Compared against what is typed now, not against what was searched, so a
  // result kept on screen from the previous keystroke cannot accuse a name it
  // does not match.
  const lowered = trimmed.toLowerCase();
  const twins = ownerId
    ? (data?.data ?? []).filter(
        (skill) =>
          skill.id !== skillId &&
          skill.authorId === ownerId &&
          skill.name.toLowerCase() === lowered,
      )
    : [];
  return twins.length > 0 ? SKILL_NAME_TAKEN : null;
}

/**
 * Whether a name that can be saved will still keep the skill from being
 * published over MCP, which takes Agent Skills names only. A warning, not a
 * refusal: the skill is created and works everywhere else.
 */
export function isSkillNameUnpublishable(name: string | null): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed !== "" && !isSpecCompliantSkillName(trimmed);
}

/** The same words the plugin form uses for a name its owner already holds. */
const SKILL_NAME_TAKEN = "Name is already in use. Try another one.";

const NAME_LOOKUP_DELAY_MS = 300;
