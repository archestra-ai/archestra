// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { HttpResponse, http } from "msw";
import pino from "pino";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { AtlassianAdminEmailResolver } from "./atlassian-admin-email-resolver";

const ADMIN_HOST = "https://api.atlassian.com";

function makeResolver(apiKey = "org-admin-key") {
  return new AtlassianAdminEmailResolver({
    apiKey,
    log: pino({ level: "silent" }),
    rateLimit: async () => {},
  });
}

/** Handlers for one org with one directory containing the given users. */
function directoryHandlers(
  users: { accountId: string; email?: string }[],
): Parameters<ReturnType<typeof useMswServer>["use"]> {
  return [
    http.get(`${ADMIN_HOST}/admin/v1/orgs`, () =>
      HttpResponse.json({ data: [{ id: "org-1" }], links: {} }),
    ),
    http.get(`${ADMIN_HOST}/admin/v2/orgs/org-1/directories`, () =>
      HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
    ),
    http.post(
      `${ADMIN_HOST}/admin/v2/orgs/org-1/directories/dir-1/users/search`,
      () => HttpResponse.json({ data: users, links: {} }),
    ),
  ];
}

describe("AtlassianAdminEmailResolver", () => {
  const server = useMswServer();

  test("resolves a managed account's email from the org directory regardless of profile visibility", async () => {
    server.use(
      ...directoryHandlers([
        { accountId: "acc-hidden", email: "hidden@example.com" },
        { accountId: "acc-visible", email: "visible@example.com" },
      ]),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-hidden")).toBe(
      "hidden@example.com",
    );
    expect(await resolver.resolveEmail("acc-visible")).toBe(
      "visible@example.com",
    );
  });

  test("loads the directory once and serves later lookups from the snapshot", async () => {
    let searchCalls = 0;
    server.use(
      http.get(`${ADMIN_HOST}/admin/v1/orgs`, () =>
        HttpResponse.json({ data: [{ id: "org-1" }], links: {} }),
      ),
      http.get(`${ADMIN_HOST}/admin/v2/orgs/org-1/directories`, () =>
        HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
      ),
      http.post(
        `${ADMIN_HOST}/admin/v2/orgs/org-1/directories/dir-1/users/search`,
        () => {
          searchCalls++;
          return HttpResponse.json({
            data: [{ accountId: "acc-1", email: "one@example.com" }],
            links: {},
          });
        },
      ),
    );

    const resolver = makeResolver();
    await resolver.resolveEmail("acc-1");
    await resolver.resolveEmail("acc-1");
    expect(searchCalls).toBe(1);
  });

  test("follows directory-search pagination cursors", async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(`${ADMIN_HOST}/admin/v1/orgs`, () =>
        HttpResponse.json({ data: [{ id: "org-1" }], links: {} }),
      ),
      http.get(`${ADMIN_HOST}/admin/v2/orgs/org-1/directories`, () =>
        HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
      ),
      http.post(
        `${ADMIN_HOST}/admin/v2/orgs/org-1/directories/dir-1/users/search`,
        async ({ request }) => {
          const body = (await request.json()) as { cursor?: string };
          cursors.push(body.cursor ?? null);
          if (!body.cursor) {
            return HttpResponse.json({
              data: [{ accountId: "acc-1", email: "one@example.com" }],
              links: { next: "cursor-2" },
            });
          }
          return HttpResponse.json({
            data: [{ accountId: "acc-2", email: "two@example.com" }],
            links: {},
          });
        },
      ),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-2")).toBe("two@example.com");
    expect(cursors).toEqual([null, "cursor-2"]);
  });

  test("falls back to the managed-profile endpoint for accounts the directory listing missed", async () => {
    server.use(
      ...directoryHandlers([]),
      http.get(`${ADMIN_HOST}/users/acc-external/manage/profile`, () =>
        HttpResponse.json({
          account: { account_id: "acc-external", email: "ext@example.com" },
        }),
      ),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-external")).toBe("ext@example.com");
  });

  test("returns null (and caches the miss) when the managed-profile fallback is denied", async () => {
    let profileCalls = 0;
    server.use(
      ...directoryHandlers([]),
      http.get(`${ADMIN_HOST}/users/acc-unmanaged/manage/profile`, () => {
        profileCalls++;
        return HttpResponse.json({}, { status: 403 });
      }),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-unmanaged")).toBeNull();
    expect(await resolver.resolveEmail("acc-unmanaged")).toBeNull();
    expect(profileCalls).toBe(1);
  });

  test("disables itself for the pass when the credential cannot call the admin APIs (plain API token)", async () => {
    let orgsCalls = 0;
    server.use(
      http.get(`${ADMIN_HOST}/admin/v1/orgs`, () => {
        orgsCalls++;
        return HttpResponse.json({}, { status: 401 });
      }),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-1")).toBeNull();
    // Disabled after the first failure: no more admin calls this pass.
    expect(await resolver.resolveEmail("acc-2")).toBeNull();
    expect(orgsCalls).toBe(1);
  });

  test("no-ops when the credential has no API token at all", async () => {
    const resolver = makeResolver("");
    expect(await resolver.resolveEmail("acc-1")).toBeNull();
  });

  test("retries a rate-limited request, honoring Retry-After", async () => {
    let orgsCalls = 0;
    server.use(
      http.get(`${ADMIN_HOST}/admin/v1/orgs`, () => {
        orgsCalls++;
        if (orgsCalls === 1) {
          // Sub-second Retry-After keeps the test fast; the parsing is the same.
          return HttpResponse.json(
            {},
            { status: 429, headers: { "Retry-After": "0.001" } },
          );
        }
        return HttpResponse.json({ data: [{ id: "org-1" }], links: {} });
      }),
      http.get(`${ADMIN_HOST}/admin/v2/orgs/org-1/directories`, () =>
        HttpResponse.json({ data: [{ directoryId: "dir-1" }], links: {} }),
      ),
      http.post(
        `${ADMIN_HOST}/admin/v2/orgs/org-1/directories/dir-1/users/search`,
        () =>
          HttpResponse.json({
            data: [{ accountId: "acc-1", email: "one@example.com" }],
            links: {},
          }),
      ),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-1")).toBe("one@example.com");
    expect(orgsCalls).toBe(2);
  });

  test("a transient directory failure only skips the bulk load — the profile fallback stays live", async () => {
    // Unlike a 401/403 credential rejection, a persistent 5xx must not disable
    // the resolver: later lookups still get the per-account profile fallback.
    let orgsCalls = 0;
    server.use(
      http.get(`${ADMIN_HOST}/admin/v1/orgs`, () => {
        orgsCalls++;
        return HttpResponse.json(
          {},
          { status: 503, headers: { "Retry-After": "0.001" } },
        );
      }),
      http.get(`${ADMIN_HOST}/users/acc-1/manage/profile`, () =>
        HttpResponse.json({
          account: { account_id: "acc-1", email: "one@example.com" },
        }),
      ),
    );

    const resolver = makeResolver();
    expect(await resolver.resolveEmail("acc-1")).toBe("one@example.com");
    // Initial attempt + 3 retries, then the bulk load is abandoned for the
    // pass (no reload on the next lookup).
    expect(orgsCalls).toBe(4);
    expect(await resolver.resolveEmail("acc-1")).toBe("one@example.com");
    expect(orgsCalls).toBe(4);
  });
});
