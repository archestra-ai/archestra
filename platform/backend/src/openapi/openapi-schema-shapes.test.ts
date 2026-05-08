import { describe, expect, test } from "vitest";
import {
  createFastifyInstance,
  registerApiRoutes,
  registerSwaggerPlugin,
} from "@/server";
import { enrichOpenApiWithRbac } from "./enrich-openapi-with-rbac";

type JsonObject = Record<string, unknown>;

describe("OpenAPI schema shapes", () => {
  test("emits codegen-safe schemas for Terraform provider inputs", async () => {
    const app = createFastifyInstance();

    try {
      await registerSwaggerPlugin(app);
      await registerApiRoutes(app);
      await app.ready();

      const spec = enrichOpenApiWithRbac(app.swagger()) as JsonObject;
      const schemas = getComponentsSchemas(spec);

      expect(schemas.EmbeddingDimensions).toMatchObject({
        type: "integer",
        enum: [3072, 1536, 768],
      });
      expect(schemas.LocalConfigEnvironmentDefault).toMatchObject({
        anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
      });

      const embeddingDimensionsSchemas = collectPropertySchemas(
        spec,
        "embeddingDimensions",
      );
      expect(embeddingDimensionsSchemas.length).toBeGreaterThan(0);
      expect(
        embeddingDimensionsSchemas.every((schema) =>
          referencesAnySchema(schema, [
            "EmbeddingDimensions",
            "EmbeddingDimensionsInput",
          ]),
        ),
      ).toBe(true);
      expect(
        embeddingDimensionsSchemas.some((schema) => "anyOf" in schema),
      ).toBe(false);

      const environmentDefaultSchemas = collectEnvironmentDefaultSchemas(spec);
      expect(environmentDefaultSchemas.length).toBeGreaterThan(0);
      for (const defaultSchema of environmentDefaultSchemas) {
        expect(
          referencesAnySchema(defaultSchema, [
            "LocalConfigEnvironmentDefault",
            "LocalConfigEnvironmentDefaultInput",
          ]),
        ).toBe(true);
        expect("anyOf" in defaultSchema).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});

function getComponentsSchemas(spec: JsonObject): Record<string, JsonObject> {
  const components = spec.components as JsonObject | undefined;
  const schemas = components?.schemas as Record<string, JsonObject> | undefined;
  if (!schemas) {
    throw new Error("OpenAPI spec has no components.schemas");
  }
  return schemas;
}

function collectPropertySchemas(
  value: unknown,
  propertyName: string,
): JsonObject[] {
  const schemas: JsonObject[] = [];

  visitJsonObjects(value, (object) => {
    const properties = object.properties as JsonObject | undefined;
    const propertySchema = properties?.[propertyName];
    if (isJsonObject(propertySchema)) {
      schemas.push(propertySchema);
    }
  });

  return schemas;
}

function collectEnvironmentDefaultSchemas(value: unknown): JsonObject[] {
  const schemas: JsonObject[] = [];

  visitJsonObjects(value, (object) => {
    const properties = object.properties as JsonObject | undefined;
    const environmentSchema = properties?.environment;
    if (!isJsonObject(environmentSchema)) {
      return;
    }

    const items = environmentSchema.items;
    if (!isJsonObject(items)) {
      return;
    }

    const itemProperties = items.properties as JsonObject | undefined;
    const defaultSchema = itemProperties?.default;
    if (isJsonObject(defaultSchema)) {
      schemas.push(defaultSchema);
    }
  });

  return schemas;
}

function referencesAnySchema(
  schema: JsonObject,
  schemaNames: string[],
): boolean {
  const allowedRefs = new Set(
    schemaNames.map((name) => `#/components/schemas/${name}`),
  );

  return hasAllowedRef(schema, allowedRefs);
}

function hasAllowedRef(value: unknown, allowedRefs: Set<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasAllowedRef(item, allowedRefs));
  }

  if (!isJsonObject(value)) {
    return false;
  }

  if (typeof value.$ref === "string" && allowedRefs.has(value.$ref)) {
    return true;
  }

  return Object.values(value).some((child) =>
    hasAllowedRef(child, allowedRefs),
  );
}

function visitJsonObjects(
  value: unknown,
  visitor: (object: JsonObject) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitJsonObjects(item, visitor);
    }
    return;
  }

  if (!isJsonObject(value)) {
    return;
  }

  visitor(value);
  for (const child of Object.values(value)) {
    visitJsonObjects(child, visitor);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
