import { describe, expect, test } from "vitest";
import { z } from "zod";
import { renderSchemaRows } from "./codegen-archestra-mcp-server-docs";

describe("codegen-archestra-mcp-server-docs", () => {
  test("renders compact nullable types without losing nested fields", () => {
    const rows = renderSchemaRows({
      type: "object",
      properties: {
        label: { type: ["string", "null"] },
        settings: {
          type: ["object", "null"],
          properties: { enabled: { type: ["boolean", "null"] } },
        },
        records: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    });

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "`label`", type: "`string \\| null`" }),
        expect.objectContaining({
          name: "`settings.enabled`",
          type: "`boolean \\| null`",
        }),
        expect.objectContaining({
          name: "`records`",
          type: "`object[] \\| null`",
        }),
        expect.objectContaining({ name: "`records[].id`", type: "`string`" }),
      ]),
    );
  });

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
});
