import { pathToFileURL } from "node:url";
import { createClient, defineConfig } from "@hey-api/openapi-ts";
import { MCP_CATALOG_API_BASE_URL } from "../consts";

/**
 * During `pnpm codegen` (CODEGEN=true), use the generated docs/openapi.json file
 * which includes all enterprise routes regardless of local .env settings.
 * For manual regeneration with a running dev server, use localhost.
 */
const archestraApiInput =
  process.env.CODEGEN === "true"
    ? "../../docs/openapi.json"
    : "http://localhost:9000/openapi.json";

const archestraApiConfig = await defineConfig({
  input: archestraApiInput,
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
      runtimeConfigPath: "./custom-client",
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
      runtimeConfigPath: "./custom-client",
    },
  ],
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createClient(archestraApiConfig);
  await createClient(archestraCatalogConfig);
}
