import type { AclEntry } from "@/types";
import { IdentityResolutionService } from "./identity-resolution";

export interface UpstreamPermissions {
  isPublic: boolean;
  users?: string[];
  groups?: string[];
}

export class AclMaterializer {
  private resolver: IdentityResolutionService;

  constructor(resolver: IdentityResolutionService) {
    this.resolver = resolver;
  }

  async materialize(permissions: UpstreamPermissions): Promise<{
    acl: AclEntry[];
    complete: boolean;
    skippedGroups: string[];
    resolvedEmails: string[];
  }> {
    if (permissions.isPublic) {
      return { acl: ["org:*"], complete: true, skippedGroups: [], resolvedEmails: [] };
    }

    const rawEmails = permissions.users || [];
    const rawGroups = permissions.groups || [];

    const resolvedUserEmails = await this.resolver.resolveEmailsToMembers(rawEmails);
    const { resolvedEmails: groupEmails, unmappedGroups } = await this.resolver.resolveGroupsToEmails(rawGroups);

    const allEmails = [...new Set([...resolvedUserEmails, ...groupEmails])];
    const aclEntries: AclEntry[] = allEmails.map((email): AclEntry => `user_email:${email.toLowerCase()}`);

    // Fail-closed condition: if unmapped groups exist, resolution is incomplete
    const complete = unmappedGroups.length === 0;

    return {
      acl: aclEntries.sort(),
      complete,
      skippedGroups: unmappedGroups,
      resolvedEmails: allEmails,
    };
  }
}
