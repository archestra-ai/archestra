import autoLoad from '@fastify/autoload';
import fastifySwagger from '@fastify/swagger';
import fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { WebSocketMessageSchema } from '@backend/websocket';

/**
 * NOTE: registering this here so that it properly gets "noticed" by the openapi spec generator
 *
 * Register our zod schemas into the global registry, such that they get output as components in the openapi spec
 * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
 */
z.globalRegistry.add(WebSocketMessageSchema, { id: 'WebSocketMessage' });

/**
 * TODO: update/configure this (somehow) so that it doesn't output the <SchemaName>Input variant component types...
 */
async function generateOpenAPISpec() {
  const app = fastify({ logger: false });
  /**
   * Add schema validator and serializer
   * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-use
   * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-use-together-with-fastifyswagger
   */
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /**
   * @fastify/swagger MUST be loaded before routes are loaded with @fastify/autoload
   *
   * https://github.com/fastify/fastify-swagger?tab=readme-ov-file#with-fastifyautoload
   */
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Archestra API',
        version: '0.0.1', // x-release-please-version
      },
    },
    /**
     * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-use-together-with-fastifyswagger
     */
    transform: jsonSchemaTransform,
    /**
     * https://github.com/turkerdev/fastify-type-provider-zod?tab=readme-ov-file#how-to-create-refs-to-the-schemas
     */
    transformObject: jsonSchemaTransformObject,
  });

  /**
   * Autoload fastify plugins
   *
   * https://github.com/fastify/fastify-autoload
   */
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  app.register(autoLoad, {
    dir: path.join(__dirname, '../../../src/backend/server/plugins'),
    // ignorePattern: /(^llm$|^mcp$)/, // Skip llm or mcp (exact match) plugin directories
    ignoreFilter: (path) => {
      const llmProxyPath = path.startsWith('/llm/');
      const archestraMcpServerPath = path.startsWith('/mcp/');
      const ollamaProxyPath = path.startsWith('/ollama/proxy');
      const isTestFile = path.includes('.test.');

      return llmProxyPath || archestraMcpServerPath || ollamaProxyPath || isTestFile;
    },
    dirNameRoutePrefix: false, // Disable automatic directory-based prefixing for clean API names
  });

  // Wait for the app to be ready
  await app.ready();

  // Generate the OpenAPI spec
  const spec = app.swagger();

  // Write to file
  const outputPath = path.join(__dirname, 'openapi.json');
  writeFileSync(outputPath, JSON.stringify(spec, null, 2));

  console.log(`OpenAPI spec written to: ${outputPath}`);

  // Close the app
  await app.close();
}

generateOpenAPISpec().catch((error) => {
  console.error(error);
  process.exit(1);
});
