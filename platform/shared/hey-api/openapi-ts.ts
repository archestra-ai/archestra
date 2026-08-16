import { pathToFileURL } from "node:url";
import { createClient, defineConfig } from "@hey-api/openapi-ts";
import { MCP_CATALOG_API_BASE_URL } from "../consts";

/**
 * Always the generated `docs/openapi.json`, never a running server.
 *
 * Reading it off the loopback API used to be the fallback when `CODEGEN=true`
 * was not set, and it produced a subtly wrong client two ways. The spec
 * declares no `servers`, so generating from a URL makes hey-api infer one from
 * the address it fetched — baking `baseUrl: 'http://127.0.0.1:9000'` into the
 * shared client that ships to every deployment. It also omits enterprise routes
 * whenever the local .env has no license, silently shrinking the client.
 *
 * Regenerate the spec first (`pnpm --dir backend codegen:openapi`) if it is
 * stale; `pnpm codegen` from the root already does that in order.
 */
const archestraApiConfig = await defineConfig({
  input: "../../docs/openapi.json",
  output: {
    path: "./hey-api/clients/api",
    clean: false,
    indexFile: true,
    tsConfigPath: "./tsconfig.json",
    format: "biome",
  },
  /**
   * We need to define the following so that we can support setting the baseUrl of the API client AT RUNTIME
   * (see https://heyapi.dev/openapi-ts/clients/fetch#runtime-api)
   */
  plugins: [
    {
      name: "@hey-api/client-fetch",
      runtimeConfigPath: "./hey-api/clients/api/custom-client",
    },
  ],
});

const archestraCatalogConfig = await defineConfig({
  input: `${MCP_CATALOG_API_BASE_URL}/docs`,
  output: {
    path: "./hey-api/clients/archestra-catalog",
    clean: false,
    indexFile: true,
    tsConfigPath: "./tsconfig.json",
    format: "biome",
  },
  plugins: [
    {
      name: "@hey-api/client-fetch",
      runtimeConfigPath: "./hey-api/clients/archestra-catalog/custom-client",
    },
  ],
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createClient(archestraApiConfig);
  await createClient(archestraCatalogConfig);
}
