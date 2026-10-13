import { BookOpen } from "lucide-react";
import { OpenAppaSolidIcon } from "@/components/openappa-icon";
import { RepositoryOwnerIcon } from "@/components/repository-owner-icon";
import { parseRepoFromSourceRef } from "@/lib/skills/skill-source";

/**
 * A standalone skill's source mark: the OpenAPPA guide's logo, the app logo
 * for a built-in skill, the repository owner for an imported one, and a book
 * otherwise. Bare, for a container that draws its own tile.
 */
export function SkillSourceGlyph({
  skill,
  appIconLogo,
}: {
  skill: {
    sourceRef: string | null;
    sourceOrigin?: string | null;
    sourceType: string;
  };
  appIconLogo: string;
}) {
  if (skill.sourceRef === "builtin:appa-guide") {
    return <OpenAppaSolidIcon className="size-6" />;
  }
  if (skill.sourceType === "built_in") {
    return <img src={appIconLogo} alt="" className="size-6 object-contain" />;
  }
  const repo = parseRepoFromSourceRef(skill.sourceRef, skill.sourceOrigin);
  if (repo) {
    return <RepositoryOwnerIcon repo={repo} className="size-6" />;
  }
  return <BookOpen className="size-4 text-muted-foreground" />;
}
