import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, defineConfig } from "@hey-api/openapi-ts";

const sourcePath = fileURLToPath(
  new URL("./runtime.openapi.json", import.meta.url),
);
const directory = fileURLToPath(new URL(".", import.meta.url));
const canonicalSource = await readFile(sourcePath, "utf8");
// Export from this runtime revision with:
// curl --fail --show-error --header "Authorization: Bearer ${APPA_RUNTIME_TOKEN:?}" "${APPA_RUNTIME_URL:?}/proxy/v1/openapi.json" -o runtime.openapi.json
const canonicalRuntimeRevision = "84d3aac63a386fe49b16f2848e69a95b2ebdbaa4";
const canonicalSourceDigest =
  "ef5f3e127f91c9396b1584a2d1363ea79b3f375a1ea2468f11739b8dab6f36ac";
if (
  createHash("sha256").update(canonicalSource).digest("hex") !==
  canonicalSourceDigest
) {
  throw new Error(
    `OpenAPPA runtime OpenAPI snapshot for ${canonicalRuntimeRevision} changed without updating its pinned digest`,
  );
}
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "archestra-appa-openapi-"),
);
const normalizedPath = path.join(temporaryDirectory, "openapi.json");
try {
  await writeFile(
    normalizedPath,
    JSON.stringify(rebaseRuntimeLocalDefinitions(JSON.parse(canonicalSource))),
  );

  const config = await defineConfig({
    input: normalizedPath,
    output: {
      path: path.join(directory, "generated"),
      clean: true,
      indexFile: true,
      tsConfigPath: path.resolve(directory, "../../../..", "tsconfig.json"),
      postProcess: ["biome:format"],
    },
    plugins: [
      {
        name: "@hey-api/client-fetch",
        runtimeConfigPath: path.join(directory, "custom-client"),
      },
    ],
  });

  await createClient(config);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

/**
 * Schemars emits local `#/$defs` refs in OpenAPI component schemas. Hey API's
 * parser expects component-rooted refs, so only rebase those references while
 * preserving the runtime document itself as the checked-in source of truth.
 */
function rebaseRuntimeLocalDefinitions(spec: Record<string, unknown>) {
  const components = spec.components as Record<string, unknown>;
  const schemas = components.schemas as Record<string, Record<string, unknown>>;
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const definitions = schema.$defs as Record<string, unknown> | undefined;
    if (!definitions) continue;
    delete schema.$defs;
    for (const [definitionName, definition] of Object.entries(definitions)) {
      schemas[`${schemaName}_${definitionName}`] = definition as Record<
        string,
        unknown
      >;
    }
    rebaseReferences(schema, schemaName);
    for (const definition of Object.values(definitions)) {
      rebaseReferences(definition, schemaName);
    }
  }
  return spec;
}

function rebaseReferences(value: unknown, schemaName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) rebaseReferences(item, schemaName);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
    record.$ref = `#/components/schemas/${schemaName}_${record.$ref.slice("#/$defs/".length)}`;
  }
  for (const child of Object.values(record))
    rebaseReferences(child, schemaName);
}
