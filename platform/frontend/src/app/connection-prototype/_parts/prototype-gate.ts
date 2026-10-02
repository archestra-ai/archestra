/**
 * The Connect prototype playground is a design sandbox, not a product page.
 * It is on in development builds and off in production builds unless a
 * deployment opts in (e.g. an internal staging stack) with
 * ARCHESTRA_FRONTEND_CONNECT_PROTOTYPES_ENABLED=true.
 */
export function isConnectPrototypePlaygroundEnabled(
  env: Record<string, string | undefined>,
): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.ARCHESTRA_FRONTEND_CONNECT_PROTOTYPES_ENABLED === "true";
}
