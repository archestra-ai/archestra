import { setupServer } from "msw/node";
import { handlers } from "./handlers";

// Pin the server to globalThis so `import("@/mocks/node")` returns the same
// instance from any module context. Next.js dev (Turbopack) sometimes bundles
// instrumentation.ts and route handlers in separate module graphs — without
// this guard each context would create its own MSW server, and overrides
// registered from a route handler would not affect requests intercepted by
// instrumentation, and vice versa.
declare global {
  // eslint-disable-next-line no-var
  var __archestraMswServer: ReturnType<typeof setupServer> | undefined;
}

export const server =
  globalThis.__archestraMswServer ?? setupServer(...handlers);

if (!globalThis.__archestraMswServer) {
  globalThis.__archestraMswServer = server;
}
