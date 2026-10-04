/**
 * The tabs across the Personal Settings header. Each is its own route, so a
 * tab is deep-linkable, survives back/forward, and only mounts what it owns.
 *
 * Account is the index rather than `/account/profile`.
 * It holds everything about you — what you can do, how you sign in, what
 * your agents may use as you.
 */
export const accountSections = [
  // Labelled Account, not Profile: it holds access, sign-in and connections
  // too.
  { label: "Account", href: "/account" },
  { label: "API Keys", href: "/account/api-keys" },
  { label: "Sessions", href: "/account/sessions" },
];
