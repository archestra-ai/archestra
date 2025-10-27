import { defineConfig, createClient } from '@hey-api/openapi-ts';
import { pathToFileURL } from 'node:url';

const archestraApiConfig = await defineConfig({
  input: 'http://localhost:9000/openapi.json',
  output: {
    path: './src/lib/clients/api',
    clean: false,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
    format: 'biome',
  },
  /**
   * We need to define the following so that we can support setting the baseUrl of the API client AT RUNTIME
   * (see https://heyapi.dev/openapi-ts/clients/fetch#runtime-api)
   */
  plugins: [
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: './custom-client',
    },
  ],
});

const archestraCatalogConfig = await defineConfig({
  input: 'https://www.archestra.ai/mcp-catalog/api/docs',
  output: {
    path: './src/lib/clients/archestra-catalog',
    clean: false,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
    format: 'biome',
  },
  plugins: [
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: './custom-client',
    },
  ],
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createClient(archestraApiConfig);
  await createClient(archestraCatalogConfig);
}
