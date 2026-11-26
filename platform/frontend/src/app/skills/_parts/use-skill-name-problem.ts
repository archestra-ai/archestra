import {
  describeUnusableSkillDescription,
  describeUnusableSkillName,
} from "@archestra/shared";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { useSkillsPaginated } from "@/lib/skills/skill.query";

export interface SkillNameProblem {
  /**
   * `invalid`: the name breaks the Agent Skills naming rules, and the form
   * links the rules. `taken`: the author already has a skill by that name.
   */
  kind: "invalid" | "taken";
  /** The whole refusal as plain text, for a tooltip. */
  message: string;
}

/**
 * Why the name in the form cannot be saved, to show under the field before
 * the save is tried: it breaks the Agent Skills naming rules, or the same
 * author already has a skill by that name.
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
  if (unusable) return { kind: "invalid", message: unusable };

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
  return twins.length > 0 ? { kind: "taken", message: SKILL_NAME_TAKEN } : null;
}

/**
 * Why the description in the form cannot be saved, as plain text: it is
 * longer than the Agent Skills specification takes. Null when it can be.
 *
 * Asked only of a description that is new to the skill, like the name: a
 * skill stored with a longer one shows nothing until it is edited. A missing
 * description is not this function's to report; the form says so itself once
 * the field has been left empty.
 */
export function skillDescriptionProblem(params: {
  /** The description in the draft; null when the manifest has none. */
  description: string | null;
  /** The stored description; null for a skill being created. */
  originalDescription: string | null;
}): string | null {
  const description = params.description ?? "";
  if (description.trim() === "") return null;
  if (description === params.originalDescription) return null;
  return describeUnusableSkillDescription(description);
}

/** The same words the plugin form uses for a name its owner already holds. */
const SKILL_NAME_TAKEN = "Name is already in use. Try another one.";

const NAME_LOOKUP_DELAY_MS = 300;
