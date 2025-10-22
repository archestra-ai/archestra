import { defineConfig, createClient } from '@hey-api/openapi-ts';
import { pathToFileURL } from 'node:url';

const archestraConfig =  await defineConfig({
  input: 'http://localhost:9000/openapi.json',
  output: {
    path: './src/lib/clients/api',
    clean: false,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
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

const mcpRegistryConfig =  await defineConfig({
  input: 'https://registry.modelcontextprotocol.io/openapi.yaml',
  output: {
    path: './src/lib/clients/mcp-registry',
    clean: false,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
  },
  plugins: [
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: './custom-client',
    },
  ],
});


if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createClient(archestraConfig);
  await createClient(mcpRegistryConfig)
}
