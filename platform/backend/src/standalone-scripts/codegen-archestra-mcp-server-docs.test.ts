import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  preserveLastUpdated,
  renderSchemaRows,
  splitToolReference,
} from "./codegen-archestra-mcp-server-docs";

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
  test("keeps dates across UTC days for unchanged split pages", () => {
    const reference = (date: string, skillDescription: string) => `---
title: "Archestra MCP Server"
description: "Built-in tools"
lastUpdated: ${date}
---

## Tools Reference

### Identity

| Tool | Description | Permission |
|------|-------------|------------|
| [\`whoami\`](#whoami) | Identify the caller. | None |

#### whoami

Identify the caller.

### Skills

| Tool | Description | Permission |
|------|-------------|------------|
| [\`load_skill\`](#load_skill) | ${skillDescription} | None |

#### load_skill

${skillDescription}
`;
    const previous = splitToolReference(
      reference("2026-11-05", "Load a skill."),
    );
    const nextDay = splitToolReference(
      reference("2026-11-06", "Load a skill."),
    );

    expect(preserveLastUpdated(nextDay.index, previous.index)).toBe(
      previous.index,
    );
    for (const slug of Object.keys(nextDay.pages)) {
      expect(
        preserveLastUpdated(nextDay.pages[slug], previous.pages[slug]),
      ).toBe(previous.pages[slug]);
    }

    const changed = splitToolReference(
      reference("2026-11-06", "Load an available skill."),
    );
    expect(
      preserveLastUpdated(
        changed.pages["skills-and-files"],
        previous.pages["skills-and-files"],
      ),
    ).toContain("lastUpdated: 2026-11-06");
    expect(
      preserveLastUpdated(
        changed.pages["getting-started"],
        previous.pages["getting-started"],
      ),
    ).toBe(previous.pages["getting-started"]);
    expect(preserveLastUpdated(changed.index, previous.index)).toBe(
      previous.index,
    );
  });
});
