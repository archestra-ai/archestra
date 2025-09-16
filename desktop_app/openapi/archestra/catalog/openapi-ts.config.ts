import { defineConfig } from '@hey-api/openapi-ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use the same catalog URL from environment variable, default to production
const CATALOG_URL = process.env.ARCHESTRA_CATALOG_URL || 'https://www.archestra.ai/mcp-catalog/api';
const CATALOG_DOCS_URL = `${CATALOG_URL}/docs`;

export default defineConfig({
  input: CATALOG_DOCS_URL,
  output: {
    path: path.join(__dirname, '../../../src/ui/lib/clients/archestra/catalog/gen'),
    clean: true,
    format: 'prettier',
    indexFile: true,
    tsConfigPath: path.join(__dirname, '../../../tsconfig.json'),
  },
  /**
   * See here for why we need this, basically to configure the baseUrl of the API
   * https://heyapi.dev/openapi-ts/clients/fetch#runtime-api
   *
   * NOTE: DON'T use an absolute path here, won't work
   */
  plugins: [
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: '../../../src/ui/lib/clients/archestra/catalog/client.ts',
    },
  ],
});
