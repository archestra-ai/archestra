/**
 * The tabs across the Personal Settings header. Each is its own route, so a
 * tab is deep-linkable, survives back/forward, and only mounts what it owns.
 *
 * Account is the index rather than `/account/profile`: it is what `/account`
 * has always shown, and every link to the bare path should keep landing on it.
 * It also carries what used to be the Permissions, Auth and Connections
 * routes: they are all about you — what you can do, how you sign in, what your
 * agents may use as you — which is what the profile page is for.
 */
export const accountSections = [
  // Labelled Account, not Profile: it holds access, sign-in and connections
  // too. The id stays `profile` so old `?section=profile` links still match.
  { id: "profile", label: "Account", href: "/account" },
  { id: "api-keys", label: "API Keys", href: "/account/api-keys" },
  { id: "sessions", label: "Sessions", href: "/account/sessions" },
] as const;

/**
 * Where an old `/account?section=…` link should land.
 *
 * These URLs are bookmarked and printed in docs, so `/account` still honours
 * the query param by redirecting to the route that replaced it. Sections that
 * were folded into Profile (permissions, auth, and the gateway-token and
 * two-factor sections before it) need no redirect: `/account` already is the
 * page they live on, and the `?highlight=personal-token` deep link opens the
 * token dialog from there.
 *
 * `?highlight=change-password` needs no mapping either — its button and dialog
 * sit in the layout.
 */
export function resolveLegacyAccountHref(section: string | null) {
  const match = accountSections.find(({ id }) => id === section);
  return match ? match.href : null;
}
