import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ServiceAccountModel from "@/models/service-account";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import serviceAccountRoutes from "./service-account";

const DAY_SECONDS = 24 * 60 * 60;

describe("service account key health", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(serviceAccountRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createAccount = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/service-accounts",
        payload: { name, role: MEMBER_ROLE_NAME },
      })
    ).json();

  const createKey = async (
    accountId: string,
    name: string,
    expiresIn?: number | null,
  ) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/service-accounts/${accountId}/tokens`,
        payload: { name, expiresIn: expiresIn ?? null },
      })
    ).json();

  const listAccounts = async () =>
    (await app.inject({ method: "GET", url: "/api/service-accounts" })).json();

  const findInList = async (id: string) =>
    (await listAccounts()).find(
      (account: { id: string }) => account.id === id,
    );

  /** Pushes a key's expiry into the past, which the create route will not do. */
  const expireKey = async (tokenId: string) =>
    db
      .update(schema.serviceAccountTokensTable)
      .set({ expiresAt: new Date(Date.now() - DAY_SECONDS * 1000) })
      .where(eq(schema.serviceAccountTokensTable.id, tokenId));

  describe("GET /api/service-accounts", () => {
    test("counts only the keys that would pass authentication", async () => {
      const account = await createAccount("health-counts");
      await createKey(account.id, "usable");
      const expired = await createKey(account.id, "expired", DAY_SECONDS * 30);
      const disabled = await createKey(account.id, "disabled");
      await expireKey(expired.id);
      await app.inject({
        method: "PATCH",
        url: `/api/service-accounts/${account.id}/tokens/${disabled.id}`,
        payload: { disabled: true },
      });

      const row = await findInList(account.id);

      expect(row.tokenCount).toBe(3);
      // The whole point: three keys, one of which actually works.
      expect(row.activeTokenCount).toBe(1);
    });

    test("an account whose only key expired is not reported as usable", async () => {
      const account = await createAccount("health-expired-only");
      const key = await createKey(account.id, "lapsed", DAY_SECONDS * 30);
      await expireKey(key.id);

      const row = await findInList(account.id);

      expect(row.disabled).toBe(false);
      expect(row.tokenCount).toBe(1);
      expect(row.activeTokenCount).toBe(0);
      expect(row.soonestExpiryAt).toBeNull();
    });

    test("reports the most recent use across all of the account's keys", async () => {
      const account = await createAccount("health-last-used");
      const older = await createKey(account.id, "older");
      const newer = await createKey(account.id, "newer");
      const olderUse = new Date("2026-01-01T00:00:00.000Z");
      const newerUse = new Date("2026-03-01T00:00:00.000Z");
      await db
        .update(schema.serviceAccountTokensTable)
        .set({ lastUsedAt: olderUse })
        .where(eq(schema.serviceAccountTokensTable.id, older.id));
      await db
        .update(schema.serviceAccountTokensTable)
        .set({ lastUsedAt: newerUse })
        .where(eq(schema.serviceAccountTokensTable.id, newer.id));

      const row = await findInList(account.id);

      expect(new Date(row.lastUsedAt).toISOString()).toBe(
        newerUse.toISOString(),
      );
    });

    test("a never-used, keyless account reports nulls rather than a zero date", async () => {
      const account = await createAccount("health-empty");

      const row = await findInList(account.id);

      expect(row).toMatchObject({
        tokenCount: 0,
        activeTokenCount: 0,
        lastUsedAt: null,
        soonestExpiryAt: null,
      });
    });

    test("soonest expiry ignores keys that are expired or disabled", async () => {
      const account = await createAccount("health-soonest");
      const soonButDisabled = await createKey(
        account.id,
        "soon-disabled",
        DAY_SECONDS * 2,
      );
      await createKey(account.id, "later", DAY_SECONDS * 60);
      await app.inject({
        method: "PATCH",
        url: `/api/service-accounts/${account.id}/tokens/${soonButDisabled.id}`,
        payload: { disabled: true },
      });

      const row = await findInList(account.id);

      // The 2-day key cannot authenticate, so warning about it would send
      // someone to rotate a key nothing is using.
      const daysOut = Math.round(
        (new Date(row.soonestExpiryAt).getTime() - Date.now()) /
          (DAY_SECONDS * 1000),
      );
      expect(daysOut).toBe(60);
    });

    test("the detail route reports the same counts as the list aggregate", async () => {
      const account = await createAccount("health-agreement");
      const expired = await createKey(account.id, "expired", DAY_SECONDS * 10);
      await createKey(account.id, "usable", DAY_SECONDS * 40);
      await expireKey(expired.id);

      const listed = await findInList(account.id);
      const detail = (
        await app.inject({
          method: "GET",
          url: `/api/service-accounts/${account.id}`,
        })
      ).json();

      // One is a SQL aggregate and the other counts rows in JS; a disagreement
      // would show the list and the account's own page different states.
      expect(detail.tokenCount).toBe(listed.tokenCount);
      expect(detail.activeTokenCount).toBe(listed.activeTokenCount);
      expect(detail.soonestExpiryAt).toBe(listed.soonestExpiryAt);
    });
  });

  describe("PATCH /api/service-accounts/bulk", () => {
    const bulkSetDisabled = (ids: string[], disabled: boolean) =>
      app.inject({
        method: "PATCH",
        url: "/api/service-accounts/bulk",
        payload: { ids, disabled },
      });

    test("disables every named account and leaves the rest alone", async () => {
      const first = await createAccount("bulk-disable-a");
      const second = await createAccount("bulk-disable-b");
      const untouched = await createAccount("bulk-disable-kept");

      const response = await bulkSetDisabled([first.id, second.id], true);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        succeeded: [
          { id: first.id, name: "bulk-disable-a" },
          { id: second.id, name: "bulk-disable-b" },
        ],
        failed: [],
      });

      const accounts =
        await ServiceAccountModel.listByOrganizationId(organizationId);
      const disabledById = new Map(
        accounts.map((account) => [account.id, account.disabled]),
      );
      expect(disabledById.get(first.id)).toBe(true);
      expect(disabledById.get(second.id)).toBe(true);
      expect(disabledById.get(untouched.id)).toBe(false);
    });

    test("disabling leaves the keys in place so enabling restores the account", async () => {
      const account = await createAccount("bulk-reversible");
      await createKey(account.id, "deploy key");

      await bulkSetDisabled([account.id], true);
      const whileDisabled = await findInList(account.id);
      await bulkSetDisabled([account.id], false);
      const afterEnable = await findInList(account.id);

      // This is what makes disable the reversible alternative to delete:
      // the key survives, so nothing has to be reissued to whatever used it.
      expect(whileDisabled.tokenCount).toBe(1);
      expect(afterEnable.disabled).toBe(false);
      expect(afterEnable.tokenCount).toBe(1);
      expect(afterEnable.activeTokenCount).toBe(1);
    });

    test("an account already in the requested state is reported as succeeded", async () => {
      const account = await createAccount("bulk-already-enabled");

      const response = await bulkSetDisabled([account.id], false);

      expect(response.statusCode).toBe(200);
      expect(response.json().succeeded).toEqual([
        { id: account.id, name: "bulk-already-enabled" },
      ]);
    });

    test("reports an account from another organization as not found and leaves it standing", async ({
      makeOrganization,
    }) => {
      const mine = await createAccount("bulk-mine");
      const otherOrg = await makeOrganization();
      const theirs = await ServiceAccountModel.create({
        organizationId: otherOrg.id,
        name: "bulk-theirs",
        role: MEMBER_ROLE_NAME,
      });

      const response = await bulkSetDisabled([mine.id, theirs.id], true);

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.succeeded).toEqual([{ id: mine.id, name: "bulk-mine" }]);
      expect(body.failed).toHaveLength(1);
      expect(body.failed[0].id).toBe(theirs.id);

      const theirsAfter = await ServiceAccountModel.findById(
        theirs.id,
        otherOrg.id,
      );
      expect(theirsAfter?.disabled).toBe(false);
    });

    test("writes one audit record showing the accounts flipping to disabled", async () => {
      const account = await createAccount("bulk-audited");

      expect((await bulkSetDisabled([account.id], true)).statusCode).toBe(200);

      const rows = await db
        .select({
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
          resourceType: schema.auditLogsTable.resourceType,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "serviceAccount.bulk_updated"),
            eq(schema.auditLogsTable.organizationId, organizationId),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("serviceAccount");
      expect(rows[0].before).toMatchObject({
        serviceAccounts: [
          { id: account.id, name: "bulk-audited", disabled: false },
        ],
      });
      expect(rows[0].after).toMatchObject({
        serviceAccounts: [
          { id: account.id, name: "bulk-audited", disabled: true },
        ],
      });
    });
  });
});
