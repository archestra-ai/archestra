import {
  DEFAULT_RESOURCE_ACCESS_RELATIONS,
  RESOURCE_ACCESS_RELATIONS,
  type ResourceAccessRelation,
  ResourceAccessRelationSchema,
} from "@archestra/shared";

/**
 * The access filters' URL parameters and how they read, without React, so
 * code that runs before a page renders (or on the server) reads a URL the
 * same way the filters do.
 */

/** The URL parameter every grant-governed list keeps the relation filter in. */
export const RESOURCE_ACCESS_PARAM = "access";
/** The URL parameter of the "Shared with" filter: subject keys. */
export const SHARED_WITH_PARAM = "sharedWith";
/** The URL parameter of the "Owner" filter: user ids. */
export const OWNER_PARAM = "owner";

/** The access filters a URL's parameters select. */
export function readResourceAccessParams(params: {
  get(name: string): string | null;
}): ResourceAccessSelectionFromUrl {
  return resolveResourceAccess({
    rawAccess: params.get(RESOURCE_ACCESS_PARAM),
    rawSharedWith: params.get(SHARED_WITH_PARAM),
    rawOwner: params.get(OWNER_PARAM),
    offerAdminAccess: true,
  });
}

export function resolveResourceAccess(params: {
  rawAccess: string | null;
  rawSharedWith: string | null;
  rawOwner: string | null;
  offerAdminAccess: boolean;
}): ResourceAccessSelectionFromUrl {
  const parsed = parseAccess(params.rawAccess);
  const withoutAdmin = parsed.filter((relation) => relation !== "others");
  const access = params.offerAdminAccess
    ? parsed
    : withoutAdmin.length > 0
      ? withoutAdmin
      : DEFAULT_RESOURCE_ACCESS_RELATIONS;
  const sharedWith = params.offerAdminAccess
    ? parseList(params.rawSharedWith)
    : undefined;
  const owner = params.offerAdminAccess
    ? parseList(params.rawOwner)
    : undefined;
  return {
    access,
    sharedWith,
    owner,
    isDefault: serializeAccess(access) === null && !sharedWith && !owner,
  };
}

/** Null for the default selection, so the default keeps a clean URL. */
export function serializeAccess(
  access: ResourceAccessRelation[],
): string | null {
  const value = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
    access.includes(relation),
  ).join(",");
  return value === DEFAULT_RESOURCE_ACCESS_RELATIONS.join(",") ? null : value;
}

type ResourceAccessSelectionFromUrl = {
  access: ResourceAccessRelation[];
  sharedWith: string[] | undefined;
  owner: string[] | undefined;
  isDefault: boolean;
};

function parseAccess(raw: string | null): ResourceAccessRelation[] {
  if (!raw) return DEFAULT_RESOURCE_ACCESS_RELATIONS;
  const requested = new Set(
    raw.split(",").flatMap((value) => {
      const parsed = ResourceAccessRelationSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
  const access = RESOURCE_ACCESS_RELATIONS.filter((relation) =>
    requested.has(relation),
  );
  return access.length > 0 ? access : DEFAULT_RESOURCE_ACCESS_RELATIONS;
}

/** A comma-separated list parameter; undefined when absent or empty. */
function parseList(raw: string | null): string[] | undefined {
  const values = [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  return values.length > 0 ? values : undefined;
}
