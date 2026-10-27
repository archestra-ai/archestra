/**
 * The tabs across the Personal Settings header. Each is its own route, so a
 * tab is deep-linkable, survives back/forward, and only mounts what it owns.
 *
 * Account is the index rather than `/account/profile`.
 * It holds everything about you — what you can do and how you sign in.
 * Credentials holds what your agents may use as you.
 */
export const accountSections = [
  // Labelled Account, not Profile: it holds access and sign-in too.
  { label: "Account", href: "/account" },
  { label: "Credentials", href: "/account/credentials" },
  { label: "API Keys", href: "/account/api-keys" },
  { label: "Sessions", href: "/account/sessions" },
];
