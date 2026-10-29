import type { OAuthClientScope } from "@archestra/shared/oauth";

/** A token may narrow a client's capabilities, never widen them. */
export function requestedOauthClientScopes(params: {
  granted: OAuthClientScope[];
  requested?: string;
}): OAuthClientScope[] | null {
  const requested = [
    ...new Set(
      params.requested === undefined
        ? params.granted
        : params.requested.split(/\s+/).filter(Boolean),
    ),
  ];
  if (
    !requested.length ||
    requested.some(
      (scope) => !params.granted.includes(scope as OAuthClientScope),
    )
  )
    return null;
  return requested as OAuthClientScope[];
}
