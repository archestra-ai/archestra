// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { notionWorkspaceIdFromGroupId } from "@archestra/shared";

/**
 * What a roster row IS for this connector type. Group snapshots are groups
 * everywhere except Notion, whose one roster row per connector is the
 * workspace itself — its details page says "Workspace(s)" wherever this page
 * family would say "Group(s)".
 */
export type RosterNoun = {
  singular: string;
  plural: string;
  /** Roster column header ("Group" / "Workspace"). */
  columnHeader: string;
  /** Noun used by the load-failure/empty states ("user groups" / "workspaces"). */
  emptyNoun: string;
  /** Label for the row's secondary identifier line. */
  idLabel: string;
  /**
   * The id the source itself shows for the row, when the group id is synthetic.
   * Notion's is `workspace-members-<workspaceId>`, so the row shows the bare
   * workspace id. Defaults to the group id.
   */
  sourceId?: (groupId: string) => string | null;
};

export const GROUP_ROSTER_NOUN: RosterNoun = {
  singular: "group",
  plural: "groups",
  columnHeader: "Group",
  emptyNoun: "user groups",
  idLabel: "Stable source ID",
};

export const WORKSPACE_ROSTER_NOUN: RosterNoun = {
  singular: "workspace",
  plural: "workspaces",
  columnHeader: "Workspace",
  emptyNoun: "workspaces",
  idLabel: "Workspace ID",
  sourceId: notionWorkspaceIdFromGroupId,
};

export function capitalizeNoun(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}
