import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureServer } from "../server";

/**
 * Generate OpenAPI specification from Fastify routes
 * Outputs to platform/shared/openapi.json for consumption by:
 * - TypeScript client generator (@shared)
 * - Go client generator (terraform provider)
 */
async function generateOpenAPISpec() {
  try {
    console.log("🔧 Configuring server...");

    const fastify = await configureServer({
      runningInCodegenMode: true,
    });

    await fastify.ready();

    console.log("📄 Generating OpenAPI specification...");

    // Generate the OpenAPI spec
    const spec = fastify.swagger();

    // Write to platform/shared/openapi.json
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const outputPath = path.join(__dirname, "../../../shared/openapi.json");

    writeFileSync(outputPath, JSON.stringify(spec, null, 2));

    console.log(`✅ OpenAPI spec written to: ${outputPath}`);

    // Close the app
    await fastify.close();

    process.exit(0);
  } catch (error) {
    console.error("❌ Failed to generate OpenAPI spec:", error);
    process.exit(1);
  }
}

generateOpenAPISpec();
