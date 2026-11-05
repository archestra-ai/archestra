// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type Action,
  type Permissions,
  type Resource,
  resourceCategories,
  resourceDescriptions,
  resourceLabels,
} from "@archestra/shared";
import {
  allAvailableActions,
  permissionDescriptions,
} from "@archestra/shared/access-control";

/** One `resource:action` a role can hold. */
export type PermissionRow = {
  resource: Resource;
  action: Action;
  /** The permission as the API and the audit log spell it. */
  key: string;
  label: string;
  description: string;
};

export type PermissionResource = {
  resource: Resource;
  label: string;
  description: string;
  /**
   * The singular noun of the objects whose access is also granted one by one,
   * on the object itself ("agent"), or null when the role is the only grant.
   */
  rows: PermissionRow[];
};

/** A resource with the rows that survived the list's filters. */
export type PermissionEntry = {
  area: string;
  resource: PermissionResource;
  rows: PermissionRow[];
};

/** "all", "granted", or an area name. */
export type PermissionFilter = string;

// Read while the areas below are built at module load, so it comes first.
const actionVerbs: Record<Action, string> = {
  read: "View",
  create: "Create",
  update: "Edit",
  delete: "Delete",
  cancel: "Cancel",
  query: "Query",
  impersonate: "Impersonate",
  "full-view": "Full view of",
  admin: "All",
  "configure-runtime": "Configure runtime for",
};

/** Every grantable permission, grouped as the roles pages show them. */
export const permissionAreas: Array<{
  name: string;
  resources: PermissionResource[];
}> = Object.entries(resourceCategories).map(([name, resources]) => ({
  name,
  resources: resources.map(buildResource),
}));

export const allPermissionRows: PermissionRow[] = permissionAreas.flatMap(
  (area) => area.resources.flatMap((resource) => resource.rows),
);

export function isGranted(permissions: Permissions, row: PermissionRow) {
  return permissions[row.resource]?.includes(row.action) ?? false;
}

export function canGrant(grantable: Permissions, row: PermissionRow) {
  return grantable[row.resource]?.includes(row.action) ?? false;
}

export function countGranted(permissions: Permissions, rows: PermissionRow[]) {
  return rows.filter((row) => isGranted(permissions, row)).length;
}

export function toggleRow(
  permissions: Permissions,
  row: PermissionRow,
): Permissions {
  const current = permissions[row.resource] ?? [];
  return setActions(
    permissions,
    row.resource,
    current.includes(row.action)
      ? current.filter((action) => action !== row.action)
      : [...current, row.action],
  );
}

/**
 * Grants or revokes every row in `rows` the author may grant. Rows the author
 * cannot grant are left as they are, so a select-all on a resource only adds
 * what the author holds and never strips a grant it could not restore.
 */
export function setRows({
  permissions,
  rows,
  grantable,
  granted,
}: {
  permissions: Permissions;
  rows: PermissionRow[];
  grantable: Permissions;
  granted: boolean;
}): Permissions {
  let next = permissions;
  const byResource = new Map<Resource, Action[]>();
  for (const row of rows) {
    if (!canGrant(grantable, row)) continue;
    byResource.set(row.resource, [
      ...(byResource.get(row.resource) ?? []),
      row.action,
    ]);
  }
  for (const [resource, actions] of byResource) {
    const current = next[resource] ?? [];
    next = setActions(
      next,
      resource,
      granted
        ? [...new Set([...current, ...actions])]
        : current.filter((action) => !actions.includes(action)),
    );
  }
  return next;
}

/**
 * The resources to show, each with the rows matching the search and the
 * filter. A resource with no matching row is dropped, as is every resource
 * outside the chosen area.
 */
export function filterPermissions({
  permissions,
  query,
  filter,
}: {
  permissions: Permissions;
  query: string;
  filter: PermissionFilter;
}): PermissionEntry[] {
  const needle = query.trim().toLowerCase();
  const byArea = filter !== "all" && filter !== "granted";
  return permissionAreas
    .filter((area) => !byArea || filter === area.name)
    .flatMap((area) =>
      area.resources
        .map((resource) => ({
          area: area.name,
          resource,
          rows: resource.rows.filter(
            (row) =>
              (filter !== "granted" || isGranted(permissions, row)) &&
              (!needle || searchText(resource, row).includes(needle)),
          ),
        }))
        .filter((entry) => entry.rows.length > 0),
    );
}

// ===
// Internal helpers
// ===

function buildResource(resource: Resource): PermissionResource {
  const label = resourceLabels[resource];
  return {
    resource,
    label,
    description: resourceDescriptions[resource],
    rows: allAvailableActions[resource].map((action) => ({
      resource,
      action,
      key: `${resource}:${action}`,
      label: rowLabel(label, action),
      description: permissionDescriptions[`${resource}:${action}`] ?? "",
    })),
  };
}

function searchText(resource: PermissionResource, row: PermissionRow) {
  return `${resource.label} ${row.label} ${row.description} ${row.key}`.toLowerCase();
}

/**
 * "View agents", "Impersonate members": a verb for the action and the
 * resource as a plural noun. Acronyms and brand casing ("MCP", "OAuth") stay
 * as they are; only a plain capitalised word drops its capital.
 */
function rowLabel(resourceLabel: string, action: Action) {
  const noun = resourceLabel
    .split(" ")
    .map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
  return `${actionVerbs[action]} ${noun}`;
}

function setActions(
  permissions: Permissions,
  resource: Resource,
  actions: Action[],
): Permissions {
  const next = { ...permissions };
  if (actions.length) next[resource] = actions;
  else delete next[resource];
  return next;
}
