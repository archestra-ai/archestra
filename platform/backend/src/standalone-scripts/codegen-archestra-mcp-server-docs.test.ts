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
});
