import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import logger from "@/logging";
import {
  createFastifyInstance,
  registerApiRoutes,
  registerHealthEndpoint,
  registerSwaggerPlugin,
} from "@/server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateOpenApiSpec() {
  const fastify = createFastifyInstance();

  logger.info("📄 Generating OpenAPI specification...");

  // Note: registerOpenApiSchemas() is called at module load time in server.ts,
  // so we don't need to call it again here

  // Register swagger plugin with custom servers for the docs
  await registerSwaggerPlugin(fastify);

  // Register health endpoint
  registerHealthEndpoint(fastify);

  // Register all API routes (includes EE routes if license is activated)
  await registerApiRoutes(fastify);

  // Initialize the fastify instance (this registers all routes with swagger)
  await fastify.ready();

  // Generate the OpenAPI spec
  const spec = fastify.swagger();

  // Output path - write to docs/openapi.json
  const outputPath = path.join(__dirname, "../../../../docs/openapi.json");

  // Ensure directory exists
  const docsDir = path.dirname(outputPath);
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  // Write the spec
  fs.writeFileSync(outputPath, JSON.stringify(spec, null, 2));

  logger.info(`✅ OpenAPI specification generated at: ${outputPath}`);
  logger.info(`   - API title: ${spec.info.title}`);
  logger.info(`   - API version: ${spec.info.version}`);
  logger.info(`   - Total paths: ${Object.keys(spec.paths || {}).length}`);

  // Close fastify instance
  await fastify.close();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateOpenApiSpec()
    .then(() => {
      // Force exit since there may be open handles (db connections, timers, etc.)
      process.exit(0);
    })
    .catch((error) => {
      logger.error(
        { error, stack: error.stack },
        "❌ Error generating OpenAPI specification",
      );
      process.exit(1);
    });
}
