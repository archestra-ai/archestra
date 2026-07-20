/**
 * Where each platform token is managed. Connection instructions use this to
 * send the user to the exact settings card (or team-dialog section) for the
 * token they selected; the target is highlighted on arrival.
 *
 * The tokens endpoint only returns tokens the caller is allowed to manage,
 * so every selectable token has a reachable management surface.
 */
export function getManageTokenLink(params: {
  isPersonalTokenSelected: boolean;
  selectedTeamToken: {
    isOrganizationToken: boolean;
    team: { id: string } | null;
  } | null;
}): { label: string; href: string } {
  const { isPersonalTokenSelected, selectedTeamToken } = params;

  if (isPersonalTokenSelected) {
    return {
      label: "Manage your personal token",
      href: "/settings/account?highlight=personal-token",
    };
  }
  if (selectedTeamToken?.isOrganizationToken) {
    return {
      label: "Manage your organization token",
      href: "/settings/organization?highlight=organization-token",
    };
  }
  if (selectedTeamToken?.team) {
    return {
      label: "Manage your team token",
      href: `/settings/teams?team=${selectedTeamToken.team.id}&section=token`,
    };
  }
  return {
    label: "Manage your tokens",
    href: "/settings/account?highlight=personal-token",
  };
}
