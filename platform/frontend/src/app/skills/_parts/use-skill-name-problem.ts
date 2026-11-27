import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

export interface SkillNameProblem {
  /** `taken`: the author already has a skill by that name. */
  kind: "taken";
  /** The whole refusal as plain text, for a tooltip. */
  message: string;
}

/**
 * Why the name in the form cannot be saved, to show under the field before
 * the save is tried: the same author already has a skill by that name, which
 * the API refuses.
 *
 * Asked only of a name that is new to the skill, so a stored skill's other
 * fields stay saveable.
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
  const searched = useDebouncedValue(trimmed, NAME_LOOKUP_DELAY_MS);
  const { data } = useSkillsPaginated(
    { search: searched, limit: 100, offset: 0, includeContent: false },
    {
      enabled: isNewName && !!ownerId && searched !== "",
      toastOnError: false,
    },
  );

  if (!isNewName) return null;

  // Compared against what is typed now, not against what was searched, so a
  // result kept on screen from the previous keystroke cannot accuse a name it
  // does not match. Exactly, as the API compares: a name that differs by
  // letter case is another name to it.
  const twins = ownerId
    ? (data?.data ?? []).filter(
        (skill) =>
          skill.id !== skillId &&
          skill.authorId === ownerId &&
          skill.name === trimmed,
      )
    : [];
  return twins.length > 0 ? { kind: "taken", message: SKILL_NAME_TAKEN } : null;
}

/** The same words the plugin form uses for a name its owner already holds. */
const SKILL_NAME_TAKEN = "Name is already in use. Try another one.";

const NAME_LOOKUP_DELAY_MS = 300;
