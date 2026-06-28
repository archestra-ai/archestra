import { MemberModel, TeamModel } from "@/models";

export class IdentityResolutionService {
  private orgId: string;

  constructor(orgId: string) {
    this.orgId = orgId;
  }

  async resolveEmailsToMembers(emails: string[]): Promise<string[]> {
    const activeMembers = await MemberModel.findAllByOrganization(this.orgId);
    const memberEmails = new Set(activeMembers.map(m => m.email.toLowerCase()));
    return emails.filter(email => memberEmails.has(email.toLowerCase()));
  }

  async resolveGroupsToEmails(groupIds: string[]): Promise<{
    resolvedEmails: string[];
    unmappedGroups: string[];
  }> {
    const resolvedEmails: string[] = [];
    const unmappedGroups: string[] = [];

    for (const groupId of groupIds) {
      const teams = await TeamModel.findTeamsByExternalGroup(this.orgId, groupId);
      if (teams.length === 0) {
        unmappedGroups.push(groupId);
        continue;
      }
      for (const team of teams) {
        const members = await TeamModel.getTeamMembersWithUsers(team.id);
        for (const member of members) {
          if (member.email) {
            resolvedEmails.push(member.email.toLowerCase());
          }
        }
      }
    }

    return {
      resolvedEmails: [...new Set(resolvedEmails)],
      unmappedGroups,
    };
  }
}
