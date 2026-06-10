import type { ResourceVisibilityScope } from "@archestra/shared";
import type { AclEntry } from "@/types";

export function buildKnowledgeFileDocumentAccessControlList(params: {
  visibility: ResourceVisibilityScope;
  teamIds: string[];
  ownerEmail: string | null | undefined;
}): AclEntry[] {
  switch (params.visibility) {
    case "personal":
      return params.ownerEmail ? [`user_email:${params.ownerEmail}`] : [];
    case "team":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "org":
      return ["org:*"];
  }
}
