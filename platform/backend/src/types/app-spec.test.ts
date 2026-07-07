import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AppSpecSchema } from "./app-spec";

// AppSpec field intent must reach the model through the published JSON schema
// (`z.toJSONSchema`), which drops plain `/** */` comments — only `.describe()`
// survives. Weak models otherwise encode the free-form `data`/`ui` prose as
// structured objects and loop through rejections discovering they are strings.
describe("AppSpecSchema published JSON schema", () => {
  const jsonSchema = z.toJSONSchema(AppSpecSchema) as {
    properties: Record<string, { description?: string }>;
  };

  test("every field carries a non-empty description", () => {
    for (const field of ["summary", "features", "data", "ui", "tools"]) {
      const description = jsonSchema.properties[field]?.description?.trim();
      expect(
        description,
        `${field} must have a non-empty description`,
      ).toBeTruthy();
    }
  });
});
