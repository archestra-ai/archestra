import fs from 'fs/promises';
import path from 'path';

import { openApiDocument } from '@mcpCatalog/api/openapi';

async function generateOpenAPISchema() {
  const outputPath = path.join(process.cwd(), 'app/mcp-catalog/api/docs/openapi.json');
  await fs.writeFile(outputPath, JSON.stringify(openApiDocument, null, 2));
  console.log(`✅ OpenAPI schema generated at: ${outputPath}`);
}

generateOpenAPISchema().catch(console.error);
