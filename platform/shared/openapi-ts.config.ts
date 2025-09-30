import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: 'http://localhost:9000/openapi.json',
  output: {
    path: './api-client',
    clean: true,
    indexFile: true,
    tsConfigPath: './tsconfig.json',
  },
});
