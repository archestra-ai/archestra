/**
 * What the composition does to decisions. A live dispatch reads the policy
 * through `getEffectivePolicy`, which reuses the stored composition while the
 * root revision holds, and hands it to the native runtime. That runtime needs
 * a Postgres event log and the battery helpers a sandbox, so these tests read
 * the same policy and decide with the runtime's offline replay: the production
 * engine over an in-memory log, where every helper consult goes unanswered and
 * only the root's no-op annotator answers.
 */
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import memberRoutes from "@/routes/member";
import {
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, describe, expect, test } from "@/test";
import {
  deployGithubWithRoster,
  GITHUB_ROSTER_ROOT,
} from "@/test/openappa-github-roster";
import { GitHubUserIdSchema, type User } from "@/types";
import { openappaBatteriesService } from "./batteries";
import { openappaDeclarations } from "./declarations";
import { parsePolicyToml, toolEntries } from "./policy-text";
import { recompileAllOnStart } from "./service";

describe("a deployed battery's composition reaches enforcement", () => {
  const openappa = { ...config.openappa };
  const sandbox = config.daggerRuntime.enabled;
  afterEach(() => {
    config.openappa = { ...openappa };
    config.daggerRuntime.enabled = sandbox;
  });

  test("no tool the battery governs falls to the root catch-all, base alone or multi-user", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
    makeAccount,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAccount,
      makeInternalMcpCatalog,
      makeTool,
    });
    const github = await bundledGithub();
    const governed = [
      ...new Set(
        [github.base, github.multiUser?.policy ?? ""]
          .flatMap(toolEntries)
          .map(({ name }) => servedName(name)),
      ),
    ];
    const targeted = new Set(
      toolEntries(github.multiUser?.policy ?? "").map(({ name }) =>
        servedName(name),
      ),
    );
    expect(targeted.size).toBeGreaterThan(0);
    expect(governed.length).toBeGreaterThan(targeted.size);

    // The catch-all's mark, which a call no battery rule governs carries.
    expect(await decide(organizationId, [UNGOVERNED])).toEqual(
      new Map([[UNGOVERNED, CATCH_ALL]]),
    );

    const multiUser = await decide(organizationId, governed);
    for (const tool of governed)
      expect(multiUser.get(tool), tool).toEqual(
        targeted.has(tool)
          ? UNANSWERED_HELPER
          : expect.not.objectContaining(CATCH_ALL),
      );

    config.daggerRuntime.enabled = false;
    await openappaBatteriesService.recompile(organizationId);
    const baseAlone = await decide(organizationId, governed);
    for (const tool of governed)
      expect(baseAlone.get(tool), tool).toEqual({
        status: expect.not.stringMatching("cannot_run"),
        actual: expect.not.stringMatching(CATCH_ALL_MARK),
      });
  });

  test("the member roster the live policy carries follows connections, memberships and the credential", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
    makeAccount,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, admin, connected } = await setUp({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAccount,
      makeInternalMcpCatalog,
      makeTool,
    });
    await connected("ana@corp.example", 1001);
    const bob = await connected("bob@corp.example", 1002);
    await openappaBatteriesService.recompile(organizationId);
    expect(await liveRoster(organizationId)).toEqual({
      "github:1001": "ana@corp.example",
      "github:1002": "bob@corp.example",
    });

    // An account two members share names neither.
    const mallory = await connected("mallory@corp.example", 1001);
    await openappaBatteriesService.recompile(organizationId);
    expect(await liveRoster(organizationId)).toEqual({
      "github:1002": "bob@corp.example",
    });

    const app = await memberApp({ organizationId, user: admin });
    try {
      const removed = await app.inject({
        method: "DELETE",
        url: "/api/members/bulk",
        payload: { targets: [{ kind: "member", id: mallory.memberId }] },
      });
      expect(removed.statusCode, removed.body).toBe(200);
    } finally {
      await app.close();
    }
    expect(await liveRoster(organizationId)).toEqual({
      "github:1001": "ana@corp.example",
      "github:1002": "bob@corp.example",
    });

    await deleteRuntimeCredentialConnection({
      organizationId,
      userId: bob.user.id,
      credentialId: "github-user",
      scope: "personal",
    });
    expect(await liveRoster(organizationId)).toEqual({
      "github:1001": "ana@corp.example",
    });

    await deleteRuntimeCredentialDefinition({
      organizationId,
      key: "github-user",
    });
    expect(await liveRoster(organizationId)).toEqual({});
  });

  test("turning the sandbox off reaches live decisions once a starting server recomposes", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
    makeAccount,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId } = await setUp({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAccount,
      makeInternalMcpCatalog,
      makeTool,
    });
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, UNANSWERED_HELPER]]),
    );

    config.daggerRuntime.enabled = false;
    // The stored composition holds until something recomposes it.
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, UNANSWERED_HELPER]]),
    );
    await recompileAllOnStart();
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, BASE_READ]]),
    );

    config.daggerRuntime.enabled = true;
    await recompileAllOnStart();
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, UNANSWERED_HELPER]]),
    );
  });

  test("unbinding and binding GitHub's token switches live decisions between the base and the multi-user target", async ({
    makeOrganization,
    makeAdmin,
    makeUser,
    makeMember,
    makeAccount,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, admin } = await setUp({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAccount,
      makeInternalMcpCatalog,
      makeTool,
    });
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, UNANSWERED_HELPER]]),
    );

    await openappaBatteriesService.setCredentialBinding({
      userId: admin.id,
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: null,
    });
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, BASE_READ]]),
    );

    await openappaBatteriesService.setCredentialBinding({
      userId: admin.id,
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: "repository-app",
    });
    expect(await decide(organizationId, [READ])).toEqual(
      new Map([[READ, UNANSWERED_HELPER]]),
    );
  });
});

/** A tool the GitHub battery does not name, on the server it governs. */
const UNGOVERNED = "mcp/github_prod/not_a_github_tool";
/** A repository read: the multi-user target asks a helper, the base labels it. */
const READ = "mcp/github_prod/get_file_contents";

type Decision = { status: string; actual: string | null };
/** The catch-all routes to the no-op annotator, answered here with a review requirement. */
const CATCH_ALL_MARK = "authority hitl";
const CATCH_ALL: Decision = { status: "failed", actual: CATCH_ALL_MARK };
/** A rule that asks a battery helper, which offline replay leaves unanswered. */
const UNANSWERED_HELPER: Decision = { status: "cannot_run", actual: null };
/** A base read's static label lets a fresh trajectory's call run. */
const BASE_READ: Decision = { status: "passed", actual: "allow" };

const ENFORCEMENT_ROOT = `${GITHUB_ROSTER_ROOT}
[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"

[[policy.authority]]
name = "hitl"
hint = "Ask the person running this session."

[policy.authority.permits]
attention = ["human-approval"]

[externals.authorities.hitl]
builtin = "hitl"
`;

type Fixtures = Parameters<typeof deployGithubWithRoster>[0] & {
  makeOrganization: () => Promise<{ id: string }>;
  makeAdmin: () => Promise<User>;
  makeUser: (overrides?: { email?: string }) => Promise<User>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides?: { role?: string },
  ) => Promise<{ id: string }>;
  makeAccount: (userId: string) => Promise<unknown>;
};

/** GitHub deployed multi-user under a root whose catch-all marks what it decides. */
async function setUp(fixtures: Omit<Fixtures, "organizationId" | "userId">) {
  const organizationId = (await fixtures.makeOrganization()).id;
  const admin = await fixtures.makeAdmin();
  await fixtures.makeAccount(admin.id);
  await fixtures.makeMember(admin.id, organizationId, {
    role: ADMIN_ROLE_NAME,
  });
  await deployGithubWithRoster({
    organizationId,
    userId: admin.id,
    makeInternalMcpCatalog: fixtures.makeInternalMcpCatalog,
    makeTool: fixtures.makeTool,
  });
  const latest = await guardrailsPolicyService.get(organizationId);
  await guardrailsPolicyService.update({
    organizationId,
    userId: admin.id,
    content: `${ENFORCEMENT_ROOT}
[externals.annotators.noop]
url = "${guardrailsPolicyService.noopAnnotator().url}"
`,
    expectedRevision: latest.revision,
  });
  /** A member connected to GitHub as `githubId`. */
  const connected = async (email: string, githubId: number) => {
    const user = await fixtures.makeUser({ email });
    await fixtures.makeAccount(user.id);
    const member = await fixtures.makeMember(user.id, organizationId);
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "personal",
      userId: user.id,
      credentialId: "github-user",
      value: "token",
      githubId: GitHubUserIdSchema.parse(githubId),
    });
    return { user, memberId: member.id };
  };
  return { organizationId, admin, connected };
}

async function bundledGithub() {
  const github = (await openappaDeclarations.bundledBatteries()).find(
    ({ name }) => name === "github",
  );
  if (!github) throw new Error("The GitHub battery is not bundled");
  return github;
}

/** A battery rule's tool, as a call on the server the root aliases it to. */
function servedName(rule: string): string {
  return rule.replace(/^mcp\/github\//, "mcp/github_prod/");
}

/**
 * Each tool called alone, on one repository, on a fresh trajectory, decided by the runtime's replay
 * over the policy a live dispatch reads.
 */
async function decide(
  organizationId: string,
  tools: string[],
): Promise<Map<string, Decision>> {
  const { content } =
    await openappaBatteriesService.getEffectivePolicy(organizationId);
  const native = await import("@archestra/openappa-rs");
  const decisions = new Map<string, Decision>();
  for (let start = 0; start < tools.length; start += REPLAY_FILES) {
    const chunk = tools.slice(start, start + REPLAY_FILES);
    const response = JSON.parse(
      await native.replayOpenappaPolicy(
        JSON.stringify({
          content,
          files: chunk.map((tool, index) => ({
            path: `${index}.appa`,
            content: `${tool} {\n  owner: "acme"\n  repo: "widgets"\n}\nexpect allow\n`,
          })),
          noopAnnotator: {
            url: guardrailsPolicyService.noopAnnotator().url,
            response: {
              version: 1,
              answer: {
                delta: {},
                requires: { history: [], attention: ["human-approval"] },
                emits: [],
              },
            },
          },
        }),
      ),
    ) as { files: { path: string; steps: Decision[] }[] };
    for (const file of response.files) {
      const [step] = file.steps;
      decisions.set(chunk[Number.parseInt(file.path, 10)], {
        status: step.status,
        actual: step.actual,
      });
    }
  }
  return decisions;
}

/** The replay engine's limit on files per run. */
const REPLAY_FILES = 32;

/** The host member roster in the policy a live dispatch reads. */
async function liveRoster(organizationId: string): Promise<unknown> {
  const { content } =
    await openappaBatteriesService.getEffectivePolicy(organizationId);
  const externals = parsePolicyToml(content)?.externals as
    | { audience?: Record<string, { readers?: unknown }> }
    | undefined;
  return externals?.audience?.["host-members"]?.readers;
}

async function memberApp(params: {
  organizationId: string;
  user: User;
}): Promise<FastifyInstanceWithZod> {
  const app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, params);
  });
  await app.register(memberRoutes);
  return app;
}
