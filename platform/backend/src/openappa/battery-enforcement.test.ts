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
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import memberRoutes from "@/routes/member";
import {
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, describe, expect, test } from "@/test";
import { bindOrganizationCredential } from "@/test/openappa-credentials";
import {
  deployGithubWithRoster,
  GITHUB_ROSTER_ROOT,
} from "@/test/openappa-github-roster";
import { GitHubUserIdSchema, type User } from "@/types";
import { openappaBatteriesService } from "./batteries";
import { bundledEntry, openappaDeclarations } from "./declarations";
import { parsePolicyToml, toolEntries } from "./policy-text";
import { recompileAllOnStart } from "./service";

describe("a deployed battery's composition reaches enforcement", () => {
  const openappa = { ...config.openappa };
  const sandbox = config.daggerRuntime.enabled;
  afterEach(() => {
    config.openappa = { ...openappa };
    config.daggerRuntime.enabled = sandbox;
  });

  test("no tool a bundled battery governs falls to the root catch-all, base alone or multi-user", async ({
    makeOrganization,
    makeAdmin,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const batteries = await openappaDeclarations.bundledBatteries();
    const deployments = batteries.flatMap((battery) =>
      (battery.multiUser ? MODES : MODES.slice(0, 1)).map((mode) => ({
        battery,
        mode,
      })),
    );
    const outcomes: Record<string, DeploymentOutcome> = {};
    for (const { battery, mode } of deployments) {
      const organizationId = (await makeOrganization()).id;
      const admin = await makeAdmin();
      await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
      const rules = deployedPolicies(battery, mode).flatMap((policy) =>
        toolEntries(policy).map(({ name }) => name),
      );
      const servers = new Map(
        [
          ...new Set(rules.flatMap((rule) => ruleCall(rule)?.namespace ?? [])),
        ].map((namespace, index) => [namespace, `served${index}_prod`]),
      );
      for (const server of servers.values()) {
        const catalog = await makeInternalMcpCatalog({
          organizationId,
          name: server.replace(/_prod$/, " prod"),
        });
        await makeTool({
          catalogId: catalog.id,
          name: `${server}__probe`,
          rawName: "probe",
        });
      }
      config.openappa.enabled = true;
      config.daggerRuntime.enabled = mode === "multi-user";
      await declareRoot({
        organizationId,
        userId: admin.id,
        content: `include = ["${bundledEntry(battery.name)}"]

[server_aliases]
${[...servers].map(([namespace, server]) => `"${namespace}" = ["${server}"]`).join("\n")}

[policy]
version = 2
${CATCH_ALL_RULES}`,
      });
      for (const variable of new Set([
        ...battery.credentials,
        ...(mode === "multi-user"
          ? (battery.multiUser?.credentials ?? [])
          : []),
      ]))
        await bindOrganizationCredential({
          organizationId,
          userId: admin.id,
          variable,
          key: variable.toLowerCase().replaceAll("_", "-"),
        });
      await openappaBatteriesService.recompile(organizationId);

      const calls = rules.flatMap((rule) => {
        const call = ruleCall(rule);
        return call ? [{ ...call, rule }] : [];
      });
      const [control, ...governed] = await decide(organizationId, [
        ...[...servers.values()].slice(0, 1).map((server) => ({
          tool: `mcp/${server}/not_a_battery_tool`,
          arguments: {},
        })),
        ...calls.map((call) => ({
          tool: `mcp/${servers.get(call.namespace)}/${call.tool}`,
          arguments: call.arguments,
        })),
      ]);
      outcomes[`${battery.name} ${mode}`] = {
        governed: calls.length > 0,
        offServer: rules.filter((rule) => !ruleCall(rule)),
        refused: governed.some(({ status }) => status === REFUSED.status),
        control: servers.size > 0 ? control : null,
        targets: [
          ...new Set(
            (await OpenAppaBatteryInstallModel.list(organizationId))
              .filter(({ batteryName }) => batteryName === battery.name)
              .map(({ target }) => target),
          ),
        ],
        onCatchAll: calls
          .filter((_, index) => governed[index]?.actual === CATCH_ALL_MARK)
          .map(({ rule }) => rule),
      };
    }

    expect(outcomes).toEqual(
      Object.fromEntries(
        deployments.map(({ battery, mode }) => {
          const governs = toolEntries(battery.base).length > 0;
          // Offline replay refuses a policy that asks a model to annotate.
          const refused = deployedPolicies(battery, mode).some(asksModel);
          return [
            `${battery.name} ${mode}`,
            {
              governed: governs,
              offServer: [],
              refused: governs && refused,
              control: governs ? (refused ? REFUSED : CATCH_ALL) : null,
              targets: [mode === "multi-user" ? "multi-user" : null],
              onCatchAll: [],
            },
          ];
        }),
      ),
    );
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
    expect(await decide(organizationId, [READ])).toEqual([UNANSWERED_HELPER]);

    config.daggerRuntime.enabled = false;
    // The stored composition holds until something recomposes it.
    expect(await decide(organizationId, [READ])).toEqual([UNANSWERED_HELPER]);
    await recompileAllOnStart();
    expect(await decide(organizationId, [READ])).toEqual([BASE_READ]);

    config.daggerRuntime.enabled = true;
    await recompileAllOnStart();
    expect(await decide(organizationId, [READ])).toEqual([UNANSWERED_HELPER]);
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
    expect(await decide(organizationId, [READ])).toEqual([UNANSWERED_HELPER]);

    await openappaBatteriesService.setCredentialBinding({
      userId: admin.id,
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: null,
    });
    expect(await decide(organizationId, [READ])).toEqual([BASE_READ]);

    await openappaBatteriesService.setCredentialBinding({
      userId: admin.id,
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: "repository-app",
    });
    expect(await decide(organizationId, [READ])).toEqual([UNANSWERED_HELPER]);
  });
});

/** A repository read: the multi-user target asks a helper, the base labels it. */
const READ: Call = {
  tool: "mcp/github_prod/get_file_contents",
  arguments: { owner: "acme", repo: "widgets", path: "README.md" },
};

const MODES = ["base", "multi-user"] as const;

type DeploymentOutcome = {
  governed: boolean;
  /** Rules on no MCP server, which no Archestra call reaches. */
  offServer: string[];
  /** Whether the replay refused to open the deployed policy. */
  refused: boolean;
  /** What a tool the battery does not name decides on its server. */
  control: Decision | null;
  targets: (string | null)[];
  /** The battery's rules whose calls the catch-all decided. */
  onCatchAll: string[];
};

type Decision = { status: string; actual: string | null };
/** The catch-all routes to the no-op annotator, answered here with a review requirement. */
const CATCH_ALL_MARK = "authority hitl";
const CATCH_ALL: Decision = { status: "failed", actual: CATCH_ALL_MARK };
/** A rule that asks a battery helper, which offline replay leaves unanswered. */
const UNANSWERED_HELPER: Decision = { status: "cannot_run", actual: null };
/** A call in a policy the replay refused to open. */
const REFUSED: Decision = { status: "refused", actual: null };
/** A base read's static label lets a fresh trajectory's call run. */
const BASE_READ: Decision = { status: "passed", actual: "allow" };

/** A catch-all through the no-op annotator, and the review its answer requires. */
const CATCH_ALL_RULES = `
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

[externals.annotators.noop]
url = "${guardrailsPolicyService.noopAnnotator().url}"
`;

async function declareRoot(params: {
  organizationId: string;
  userId: string;
  content: string;
}) {
  const latest = await guardrailsPolicyService.get(params.organizationId);
  await guardrailsPolicyService.update({
    ...params,
    expectedRevision: latest.revision,
  });
}

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
  await declareRoot({
    organizationId,
    userId: admin.id,
    content: `${GITHUB_ROSTER_ROOT}${CATCH_ALL_RULES}`,
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

type Call = { tool: string; arguments: Record<string, string> };

/** The policies a battery deploys in a mode: its base, and its target first when multi-user. */
function deployedPolicies(
  battery: { base: string; multiUser?: { policy: string } },
  mode: (typeof MODES)[number],
): string[] {
  return mode === "multi-user" && battery.multiUser
    ? [battery.multiUser.policy, battery.base]
    : [battery.base];
}

/** Whether a policy declares an annotator answered by model inference. */
function asksModel(policy: string): boolean {
  const annotators = (
    parsePolicyToml(policy)?.policy as { annotator?: unknown } | undefined
  )?.annotator;
  return (
    Array.isArray(annotators) &&
    annotators.some(
      (annotator: { builtin?: unknown }) =>
        typeof annotator.builtin === "string" &&
        annotator.builtin !== "archestra",
    )
  );
}

/**
 * Each call alone on a fresh trajectory, decided by the runtime's replay over
 * the policy a live dispatch reads.
 */
async function decide(
  organizationId: string,
  calls: Call[],
): Promise<Decision[]> {
  const { content } =
    await openappaBatteriesService.getEffectivePolicy(organizationId);
  const native = await import("@archestra/openappa-rs");
  const decisions: Decision[] = [];
  for (let start = 0; start < calls.length; start += REPLAY_FILES) {
    const chunk = calls.slice(start, start + REPLAY_FILES);
    const response = JSON.parse(
      await native.replayOpenappaPolicy(
        JSON.stringify({
          content,
          files: chunk.map((call, index) => ({
            path: `${String(index).padStart(2, "0")}.appa`,
            content: `${call.tool} {\n${Object.entries(call.arguments)
              .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}\n`)
              .join("")}}\nexpect allow\n`,
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
      // A file with no step is one the replay refused before calling anything.
      const [step = REFUSED] = file.steps;
      decisions[start + Number.parseInt(file.path, 10)] = {
        status: step.status,
        actual: step.actual,
      };
    }
  }
  return decisions;
}

/**
 * A call a rule governs: its namespace, its tool, and the arguments its pattern
 * names, a wildcard taking any value. Null for a rule on no MCP server.
 */
function ruleCall(rule: string): {
  namespace: string;
  tool: string;
  arguments: Record<string, string>;
} | null {
  const match = /^mcp\/([^/]+)\/([^(]+)(?:\((.*)\))?$/.exec(rule);
  if (!match) return null;
  const [, namespace, tool, pattern] = match;
  return {
    namespace,
    tool,
    arguments: {
      ...ONE_REPOSITORY,
      ...Object.fromEntries(
        (pattern ?? "")
          .split(",")
          .filter(Boolean)
          .map((pair) => {
            const [key, value] = pair.split(":");
            return [key, value === "*" ? "any" : value];
          }),
      ),
    },
  };
}

/** Arguments that name one repository, which the GitHub rules' helpers ask about. */
const ONE_REPOSITORY = { owner: "acme", repo: "widgets" };

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
