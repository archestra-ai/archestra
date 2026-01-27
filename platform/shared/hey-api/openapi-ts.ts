import { readFileSync, writeFileSync } from "node:fs";
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

/**
 * Post-process generated types to fix hey-api's handling of nullable types.
 *
 * hey-api incorrectly generates `| unknown` instead of `| null` for OpenAPI
 * schemas with `anyOf: [{...}, {type: "null"}]` patterns. This particularly
 * affects tool_calls fields which should be `Array<...> | null` but get
 * generated as `Array<...> | unknown`.
 *
 * This function fixes specific patterns where the nullable type is at the
 * end of an array type definition (e.g., `}> | unknown` -> `}> | null`).
 */
function fixNullableTypes(filePath: string): void {
  const content = readFileSync(filePath, "utf-8");
  // Fix pattern: `}> | unknown;` at end of array definitions should be `}> | null;`
  // This specifically targets nullable array types that hey-api incorrectly generates
  const fixed = content.replace(/\}> \| unknown;/g, "}> | null;");
  if (fixed !== content) {
    writeFileSync(filePath, fixed, "utf-8");
    // biome-ignore lint/suspicious/noConsole: Intentional info output during codegen
    console.log(`[post-process] Fixed nullable types in ${filePath}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createClient(archestraApiConfig);
  await createClient(archestraCatalogConfig);

  // Post-process to fix hey-api nullable type generation issues
  fixNullableTypes("./hey-api/clients/api/types.gen.ts");
}
