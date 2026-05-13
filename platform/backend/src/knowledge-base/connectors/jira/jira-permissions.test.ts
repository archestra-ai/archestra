import type { Version3Client } from "jira.js";
import pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { JiraPermissionResolver } from "./jira-permissions";

function makeClient(params: {
  rolesByProject: Record<string, Record<string, string>>;
  actorsByRole: Record<string, unknown[]>;
  emailsByAccountId: Record<string, string | undefined>;
  onGetUser?: (accountId: string) => void;
}) {
  const getProjectRoles = vi.fn(
    async ({ projectIdOrKey }: { projectIdOrKey: string }) => {
      return params.rolesByProject[projectIdOrKey] ?? {};
    },
  );
  const getProjectRole = vi.fn(
    async ({ projectIdOrKey, id }: { projectIdOrKey: string; id: number }) => {
      const key = `${projectIdOrKey}:${id}`;
      return { actors: params.actorsByRole[key] ?? [] };
    },
  );
  const getUser = vi.fn(async ({ accountId }: { accountId: string }) => {
    params.onGetUser?.(accountId);
    return { emailAddress: params.emailsByAccountId[accountId] };
  });

  return {
    client: {
      projectRoles: { getProjectRoles, getProjectRole },
      users: { getUser },
    } as unknown as Version3Client,
    spies: { getProjectRoles, getProjectRole, getUser },
  };
}

describe("JiraPermissionResolver", () => {
  test("returns undefined when projectKey is missing", async () => {
    const { client } = makeClient({
      rolesByProject: {},
      actorsByRole: {},
      emailsByAccountId: {},
    });
    const resolver = new JiraPermissionResolver({
      client,
      log: pino({ level: "silent" }),
      isCloud: true,
    });

    expect(
      await resolver.resolveForIssue({ projectKey: undefined }),
    ).toBeUndefined();
    expect(await resolver.resolveForIssue({ projectKey: "" })).toBeUndefined();
  });

  test("aggregates users and groups across roles, dropping users with hidden emails", async () => {
    const { client } = makeClient({
      rolesByProject: {
        ENG: {
          Administrators:
            "https://example.atlassian.net/rest/api/3/project/ENG/role/10002",
          Developers:
            "https://example.atlassian.net/rest/api/3/project/ENG/role/10001",
        },
      },
      actorsByRole: {
        "ENG:10001": [
          { actorUser: { accountId: "u-alice" } },
          { actorUser: { accountId: "u-bob" } },
          { actorGroup: { name: "engineers" } },
        ],
        "ENG:10002": [
          { actorUser: { accountId: "u-alice" } },
          { actorUser: { accountId: "u-charlie" } },
        ],
      },
      emailsByAccountId: {
        "u-alice": "Alice@Example.com",
        "u-bob": undefined,
        "u-charlie": "charlie@example.com",
      },
    });

    const resolver = new JiraPermissionResolver({
      client,
      log: pino({ level: "silent" }),
      isCloud: true,
    });

    const result = await resolver.resolveForIssue({ projectKey: "ENG" });

    expect(result?.users.sort()).toEqual([
      "alice@example.com",
      "charlie@example.com",
    ]);
    expect(result?.groups).toEqual(["engineers"]);
  });

  test("caches project lookups across issues in the same project", async () => {
    const { client, spies } = makeClient({
      rolesByProject: {
        ENG: {
          Developers:
            "https://example.atlassian.net/rest/api/3/project/ENG/role/10001",
        },
      },
      actorsByRole: {
        "ENG:10001": [{ actorUser: { accountId: "u-alice" } }],
      },
      emailsByAccountId: { "u-alice": "alice@example.com" },
    });

    const resolver = new JiraPermissionResolver({
      client,
      log: pino({ level: "silent" }),
      isCloud: true,
    });

    await resolver.resolveForIssue({ projectKey: "ENG" });
    await resolver.resolveForIssue({ projectKey: "ENG" });
    await resolver.resolveForIssue({ projectKey: "ENG" });

    expect(spies.getProjectRoles).toHaveBeenCalledTimes(1);
    expect(spies.getProjectRole).toHaveBeenCalledTimes(1);
    expect(spies.getUser).toHaveBeenCalledTimes(1);
  });

  test("returns undefined for project when role fetching fails", async () => {
    const failingClient = {
      projectRoles: {
        getProjectRoles: vi.fn(async () => {
          throw new Error("403 Forbidden");
        }),
        getProjectRole: vi.fn(),
      },
      users: { getUser: vi.fn() },
    } as unknown as Version3Client;

    const resolver = new JiraPermissionResolver({
      client: failingClient,
      log: pino({ level: "silent" }),
      isCloud: true,
    });

    expect(
      await resolver.resolveForIssue({ projectKey: "ENG" }),
    ).toBeUndefined();
  });
});
