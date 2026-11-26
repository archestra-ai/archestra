import { describeUnusableSkillName } from "@archestra/shared";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

export interface SkillNameProblem {
  title: string;
  detail: string;
}

/**
 * Why the name in the form cannot be saved, to show under the field before
 * the save is tried: it cannot be a folder name, or the same author already
 * has a skill by that name in any letter case.
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
}): SkillNameProblem | null {
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
  if (unusable) return { title: "This name cannot be used", detail: unusable };

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
  // An exact duplicate first: older data can hold both spellings.
  const twin = twins.find((skill) => skill.name === trimmed) ?? twins[0];
  if (!twin) return null;
  return {
    title: "Name already in use",
    detail:
      twin.name === trimmed
        ? `A skill named "${twin.name}" by the same author already exists.`
        : `A skill named "${twin.name}" by the same author already exists. Names that differ only by letter case count as the same name.`,
  };
}

const NAME_LOOKUP_DELAY_MS = 300;
