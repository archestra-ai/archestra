import type { ConfluenceClient } from "confluence.js";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { ConfluencePermissionResolver } from "./confluence-permissions";

function makeResolver(params: {
  pageRestrictions?: Record<string, unknown>;
  spaceResponses?: Record<string, unknown>;
  userEmails?: Record<string, string | undefined>;
}) {
  const getRestrictionsForOperation = vi.fn(
    async ({ id }: { id: string }) =>
      params.pageRestrictions?.[id] ?? {
        restrictions: { user: { results: [] }, group: { results: [] } },
      },
  );

  const sendRequest = vi.fn(async (request: unknown) => {
    const config = request as { url: string; params?: Record<string, unknown> };
    if (config.url.startsWith("/api/user")) {
      const accountId =
        (config.params?.accountId as string | undefined) ??
        (config.params?.key as string | undefined) ??
        "";
      const email = params.userEmails?.[accountId];
      return { email };
    }
    const spaceKey = decodeURIComponent(
      config.url.split("/api/space/")[1] ?? "",
    );
    return params.spaceResponses?.[spaceKey] ?? { permissions: [] };
  });

  const client = {
    contentRestrictions: { getRestrictionsForOperation },
    sendRequest,
  } as unknown as ConfluenceClient;

  return {
    resolver: new ConfluencePermissionResolver({
      client,
      log: pino({ level: "silent" }),
      isCloud: true,
    }),
    spies: { getRestrictionsForOperation, sendRequest },
  };
}

describe("ConfluencePermissionResolver", () => {
  test("uses page-level restrictions when present", async () => {
    const { resolver } = makeResolver({
      pageRestrictions: {
        "page-1": {
          restrictions: {
            user: {
              results: [{ accountId: "u-alice" }, { accountId: "u-bob" }],
            },
            group: { results: [{ name: "engineers" }] },
          },
        },
      },
      userEmails: {
        "u-alice": "alice@example.com",
        "u-bob": "bob@example.com",
      },
    });

    const result = await resolver.resolveForPage({
      pageId: "page-1",
      spaceKey: "ENG",
    });

    expect(result?.users.sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(result?.groups).toEqual(["engineers"]);
  });

  test("falls back to space permissions when no page-level restriction is set", async () => {
    const { resolver } = makeResolver({
      pageRestrictions: {
        "page-2": {
          restrictions: { user: { results: [] }, group: { results: [] } },
        },
      },
      spaceResponses: {
        ENG: {
          permissions: [
            {
              operation: { operation: "read" },
              subjects: {
                user: { results: [{ accountId: "u-carol" }] },
                group: { results: [{ name: "writers" }] },
              },
            },
            {
              operation: { operation: "write" },
              subjects: { user: { results: [{ accountId: "u-skip" }] } },
            },
          ],
        },
      },
      userEmails: { "u-carol": "carol@example.com" },
    });

    const result = await resolver.resolveForPage({
      pageId: "page-2",
      spaceKey: "ENG",
    });

    expect(result?.users).toEqual(["carol@example.com"]);
    expect(result?.groups).toEqual(["writers"]);
  });

  test("returns undefined when both page and space permissions are empty", async () => {
    const { resolver } = makeResolver({
      pageRestrictions: {
        "page-3": {
          restrictions: { user: { results: [] }, group: { results: [] } },
        },
      },
      spaceResponses: { ENG: { permissions: [] } },
    });

    const result = await resolver.resolveForPage({
      pageId: "page-3",
      spaceKey: "ENG",
    });

    expect(result).toBeUndefined();
  });

  test("caches space lookups across pages in the same space", async () => {
    const { resolver, spies } = makeResolver({
      pageRestrictions: {
        a: { restrictions: { user: { results: [] }, group: { results: [] } } },
        b: { restrictions: { user: { results: [] }, group: { results: [] } } },
      },
      spaceResponses: {
        ENG: {
          permissions: [
            {
              operation: { operation: "read" },
              subjects: {
                user: { results: [{ accountId: "u-alice" }] },
                group: { results: [] },
              },
            },
          ],
        },
      },
      userEmails: { "u-alice": "alice@example.com" },
    });

    await resolver.resolveForPage({ pageId: "a", spaceKey: "ENG" });
    await resolver.resolveForPage({ pageId: "b", spaceKey: "ENG" });

    // One restriction call per page + one space lookup + one user lookup.
    expect(spies.getRestrictionsForOperation).toHaveBeenCalledTimes(2);
    const spaceCalls = spies.sendRequest.mock.calls.filter(([req]) =>
      (req as { url: string }).url.startsWith("/api/space/"),
    );
    expect(spaceCalls).toHaveLength(1);
    const userCalls = spies.sendRequest.mock.calls.filter(([req]) =>
      (req as { url: string }).url.startsWith("/api/user"),
    );
    expect(userCalls).toHaveLength(1);
  });
});
