import { pathToFileURL } from "node:url";
import { createClient, defineConfig } from "@hey-api/openapi-ts";

const archestraApiConfig = await defineConfig({
  input: "http://localhost:9000/openapi.json",
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
  input: "https://archestra.ai/mcp-catalog/api/docs",
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
