import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
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
