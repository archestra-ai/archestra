import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: 'http://localhost:9000/openapi.json',
  output: {
    path: './api-client',
    clean: false,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
  },
  /**
   * See here for why we need this, basically to configure the baseUrl of the API client
   * https://heyapi.dev/openapi-ts/clients/fetch#runtime-api
   *
   * NOTE: DON'T use an absolute path here, won't work
   */
  plugins: [
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: './custom-client',
      baseUrl: false, // don't use the baseUrl from the config
    },
  ],
});
