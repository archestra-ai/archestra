import type { AclEntry, KnowledgeBaseVisibility } from "@/types";

/**
 * Build the ACL strings for a document based on the knowledge base visibility mode.
 *
 * The ACL is stored on both kb_documents and denormalized onto kb_chunks for
 * efficient query-time filtering using PostgreSQL's `?|` operator with a GIN index.
 */
export function buildDocumentAcl(params: {
  visibility: KnowledgeBaseVisibility;
  teamIds: string[];
  permissions?: {
    users?: string[];
    groups?: string[];
    isPublic?: boolean;
  };
}): AclEntry[] {
  switch (params.visibility) {
    case "org-wide":
      return ["org:*"];
    case "team-scoped":
      return params.teamIds.map((id): AclEntry => `team:${id}`);
    case "auto-sync-permissions": {
      const acl: AclEntry[] = [];
      if (params.permissions?.isPublic) {
        acl.push("org:*");
      }
      if (params.permissions?.users) {
        acl.push(
          ...params.permissions.users.map((u): AclEntry => `user_email:${u}`),
        );
      }
      if (params.permissions?.groups) {
        acl.push(
          ...params.permissions.groups.map((g): AclEntry => `group:${g}`),
        );
      }
      // Fallback: if no permissions extracted, grant org-wide access
      if (acl.length === 0) {
        acl.push("org:*");
      }
      return acl;
    }
  }
}

/**
 * Build the ACL strings for a user at query time.
 * Used to construct the user_acl parameter for the hybrid search CTE.
 */
export function buildUserAcl(params: {
  userEmail: string;
  teamIds: string[];
  visibility: KnowledgeBaseVisibility;
}): AclEntry[] {
  const acl: AclEntry[] = [];

  if (params.visibility === "org-wide") {
    acl.push("org:*");
  }

  acl.push(`user_email:${params.userEmail}`);

  for (const teamId of params.teamIds) {
    acl.push(`team:${teamId}`);
  }

  return acl;
}
