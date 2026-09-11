import { describe, expect, test } from "vitest";
import { z } from "zod";
import { renderSchemaRows } from "./codegen-archestra-mcp-server-docs";

describe("codegen-archestra-mcp-server-docs", () => {
  test("renders nullable nested enterprise-managed config fields", () => {
    const schema = z.toJSONSchema(
      z.object({
        assignments: z.array(
          z.object({
            enterpriseManagedConfig: z
              .object({
                requestedCredentialType: z.enum([
                  "id_jag",
                  "bearer_token",
                  "secret",
                ]),
                responseFieldPath: z.string().optional(),
              })
              .nullable()
              .optional(),
            mcpServerId: z.string().uuid().nullable().optional(),
          }),
        ),
      }),
      { io: "input" },
    );

    const rows = renderSchemaRows(schema as never);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "`assignments[].enterpriseManagedConfig`",
          type: "`object \\| null`",
        }),
        expect.objectContaining({
          name: "`assignments[].enterpriseManagedConfig.requestedCredentialType`",
          type: '`"id_jag" \\| "bearer_token" \\| "secret"`',
        }),
        expect.objectContaining({
          name: "`assignments[].mcpServerId`",
          type: "`string \\| null`",
        }),
      ]),
    );
  });

  test("renders every field of a discriminated object union", () => {
    const schema = z.toJSONSchema(
      z.object({
        reference: z.discriminatedUnion("source", [
          z.object({
            source: z.literal("native"),
            skillId: z.string(),
            label: z.string().describe("Native label."),
          }),
          z.object({
            source: z.literal("external_mcp"),
            mcpServerId: z.string(),
            uri: z.string(),
            label: z.string().describe("External label."),
          }),
        ]),
      }),
      { io: "input" },
    );

    const rows = renderSchemaRows(schema as never);

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "`reference`",
          type: "`object`",
        }),
        expect.objectContaining({
          name: "`reference.source`",
          type: '`"native" \\| "external_mcp"`',
          required: "Yes",
          description: "",
        }),
        expect.objectContaining({
          name: "`reference.skillId`",
          required: 'When `source="native"`',
        }),
        expect.objectContaining({
          name: "`reference.mcpServerId`",
          required: 'When `source="external_mcp"`',
        }),
        expect.objectContaining({
          name: "`reference.uri`",
          required: 'When `source="external_mcp"`',
        }),
        expect.objectContaining({
          name: "`reference.label`",
          description:
            'When `source="native"`: Native label. When `source="external_mcp"`: External label.',
        }),
      ]),
    );
  });
});
