/**
 * Hides two Better Auth warnings that every database-backed test file
 * triggers, because the test server does not mount the discovery routes.
 *
 * The filter is installed once per worker and never swapped per file. The
 * OpenAI, Anthropic and Google GenAI SDKs cache `console.warn.bind(console)`
 * in a module-level WeakMap keyed by `console` the first time a client logs.
 * A wrapper defined in setup.ts would be cached there together with
 * setup.ts's whole module scope, so in shared workers each file's closed
 * PGlite (about 265 MB) would stay alive until the worker exits.
 */
const IGNORED_WARNINGS = [
  "[Better Auth]: Please ensure '/.well-known/oauth-authorization-server' exists",
  "[Better Auth]: Please ensure '/.well-known/openid-configuration' exists",
];

const INSTALLED = Symbol.for("archestra.test.quietConsoleWarn");

installQuietConsoleWarn();

// ===

function installQuietConsoleWarn(): void {
  const current = console.warn as typeof console.warn & {
    [INSTALLED]?: true;
  };
  if (current[INSTALLED]) return;
  const quiet = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (IGNORED_WARNINGS.some((warning) => message.includes(warning))) return;
    current(...args);
  };
  console.warn = Object.assign(quiet, { [INSTALLED]: true as const });
}
