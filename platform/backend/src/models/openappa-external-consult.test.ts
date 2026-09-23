import { count } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import OpenappaExternalConsultModel from "./openappa-external-consult";

describe("OpenappaExternalConsultModel.deleteExpired", () => {
  test("keeps deleting in batches until no expired row is left", async ({
    makeOrganization,
  }) => {
    const { id: organizationId } = await makeOrganization();
    const expired = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await db.insert(schema.openappaExternalConsultsTable).values(
      [expired, expired, expired, expired, expired, new Date()].map(
        (createdAt) => ({
          id: crypto.randomUUID(),
          organizationId,
          createdAt,
          startedAt: createdAt,
          durationMs: 1,
          role: "annotator" as const,
          externalName: "scan",
          backend: "url" as const,
          request: {},
          outcome: "answered" as const,
          root: "root",
          trajectory: "root",
        }),
      ),
    );

    const deleted = await OpenappaExternalConsultModel.deleteExpired({
      retentionDays: 30,
      batchSize: 2,
    });

    expect(deleted).toBe(5);
    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.openappaExternalConsultsTable);
    expect(total).toBe(1);
  });
});
