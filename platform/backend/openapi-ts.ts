import { defineConfig, createClient } from '@hey-api/openapi-ts';
import { pathToFileURL } from 'node:url';


const archestraCatalogConfig = await defineConfig({
  input: 'https://www.archestra.ai/mcp-catalog/api/docs',
  output: {
    path: './src/clients/archestra-catalog',
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
  await createClient(archestraCatalogConfig);
}
