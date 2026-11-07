import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  generateDocsFiles,
  renderSchemaRows,
} from "./codegen-archestra-mcp-server-docs";

describe("codegen-archestra-mcp-server-docs", () => {
  test("keeps the committed date when no page changed, and moves it when one did", () => {
    const committed = generateDocsFiles({
      readFile: () => null,
      today: "2026-01-01",
    });
    expect(Object.keys(committed)).toContain("index.md");
    expect(Object.keys(committed).length).toBeGreaterThan(1);

    const rerun = generateDocsFiles({
      readFile: (name) => committed[name] ?? null,
      today: "2026-01-02",
    });
    expect(rerun).toEqual(committed);

    const [topicPage] = Object.keys(committed).filter(
      (name) => name !== "index.md",
    );
    const afterToolChange = generateDocsFiles({
      readFile: (name) =>
        name === topicPage ? "stale page" : (committed[name] ?? null),
      today: "2026-01-02",
    });
    for (const content of Object.values(afterToolChange)) {
      expect(content).toContain("lastUpdated: 2026-01-02");
    }
  });

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
