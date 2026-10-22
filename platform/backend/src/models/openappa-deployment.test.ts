import { sql } from "drizzle-orm";
import db from "@/database";
import { describe, expect, test } from "@/test";
import OpenAppaDeploymentModel from "./openappa-deployment";

describe("OpenAppaDeploymentModel.head", () => {
  test("names the revision at the head and when that revision was published", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    await db.execute(sql`
      INSERT INTO openappa_policy_files (hash, bytes)
      VALUES ('first', '\\x00'), ('second', '\\x01')
    `);
    await db.execute(
      sql`INSERT INTO openappa_deployments (name, head) VALUES (${id}, 2)`,
    );
    await db.execute(sql`
      INSERT INTO openappa_policy_revisions (deployment, revision, hash, published_at)
      VALUES (${id}, 1, 'first', '2026-10-17T10:00:00Z'),
             (${id}, 2, 'second', '2026-10-17T11:00:00Z'),
             (${id}, 3, 'first', '2026-10-17T12:00:00Z')
    `);

    expect(await OpenAppaDeploymentModel.head(id)).toEqual({
      revision: 2,
      publishedAt: new Date("2026-10-17T11:00:00Z"),
    });
  });

  test("is null for an organization that has not published", async ({
    makeOrganization,
  }) => {
    const { id } = await makeOrganization();
    expect(await OpenAppaDeploymentModel.head(id)).toBeNull();
  });
});
