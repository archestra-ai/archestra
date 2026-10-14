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
      const policies = deployedPolicies(battery, mode);
      const rules = policies.flatMap((policy) =>
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

      const calls = governedCalls(rules).map((call) => ({
        ...call,
        tool: `mcp/${servers.get(call.namespace)}/${call.tool}`,
      }));
      const controls = [...servers.values()].slice(0, 1).map((server) => ({
        label: "control",
        tool: `mcp/${server}/not_a_battery_tool`,
        arguments: {},
      }));
      const decided = await decide(organizationId, [...controls, ...calls]);
      const [control, ...governed] = decided;
      const builtins = policies.flatMap(modelBuiltins);
      const unopened = decided.flatMap((decision, index) =>
        decision.refusal === undefined
          ? []
          : [{ label: [...controls, ...calls][index].label, decision }],
      );
      outcomes[`${battery.name} ${mode}`] = {
        governed: calls.length > 0,
        offServer: rules.filter((rule) => !ruleCall(rule)),
        refusedBy: [
          ...new Set(
            unopened.flatMap(({ decision }) =>
              builtins.filter((builtin) =>
                decision.refusal?.includes(JSON.stringify(builtin)),
              ),
            ),
          ),
        ],
        unopened: unopened
          .filter(
            ({ decision }) =>
              !builtins.some((builtin) =>
                decision.refusal?.includes(JSON.stringify(builtin)),
              ),
          )
          .map(({ label, decision }) => `${label}: ${decision.refusal}`),
        control: servers.size > 0 ? control : null,
        targets: [
          ...new Set(
            (await OpenAppaBatteryInstallModel.list(organizationId))
              .filter(({ batteryName }) => batteryName === battery.name)
              .map(({ target }) => target),
          ),
        ],
        catchAllMismatches: calls
          .filter(
            ({ rule }, index) =>
              (governed[index].actual === CATCH_ALL_MARK) !== (rule === null),
          )
          .map(({ label }) => label),
        misdecided: calls.flatMap(({ label, rule, arguments: args }, index) => {
          const { actual, refusal, error } = governed[index];
          const helper = rule === null ? null : ruleHelper(policies, rule);
          const unanswered =
            helper !== null &&
            UNANSWERED_ANNOTATOR.exec(error ?? "")?.[1] === helper.name;
          // A helper whose audience the call fills is consulted, so only its
          // unanswered consult shows the rule decided; otherwise any decision.
          const asked = helper?.reads.every((read) => read in args) === true;
          const expected =
            refusal !== undefined ||
            (asked ? unanswered : actual !== null || unanswered);
          return expected ? [] : [`${label}: ${actual ?? error}`];
        }),
      };
    }

    expect(outcomes).toEqual(
      Object.fromEntries(
        deployments.map(({ battery, mode }) => {
          const governs = toolEntries(battery.base).length > 0;
          // Offline replay refuses a policy that asks a model to annotate.
          const builtins = [
            ...new Set(deployedPolicies(battery, mode).flatMap(modelBuiltins)),
          ];
          const refused = governs && builtins.length > 0;
          return [
            `${battery.name} ${mode}`,
            {
              governed: governs,
              offServer: [],
              refusedBy: refused ? builtins : [],
              unopened: [],
              control: governs ? (refused ? UNOPENED : CATCH_ALL) : null,
              targets: [mode === "multi-user" ? "multi-user" : null],
              catchAllMismatches: [],
              misdecided: [],
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
  /** The model annotators whose declaration made the replay refuse the policy. */
  refusedBy: string[];
  /** Calls the replay ran no step for, for any other reason. */
  unopened: string[];
  /** What a tool the battery does not name decides on its server. */
  control: Decision | null;
  targets: (string | null)[];
  /**
   * Calls the catch-all decided that the battery governs, and calls the battery
   * leaves to the root that something else decided.
   */
  catchAllMismatches: string[];
  /**
   * Calls their rule did not decide: a call whose rule's battery helper reads
   * only arguments the call gives must show that helper's unanswered consult,
   * and any other call a decision or such a consult.
   */
  misdecided: string[];
};

type Decision = {
  status: string;
  actual: string | null;
  /** Why the step decided nothing, or the feedback of its decision. */
  error?: string;
  /** Why the replay ran no step for the call; absent when it ran one. */
  refusal?: string;
};
/** The catch-all routes to the no-op annotator, answered here with a review requirement. */
const CATCH_ALL_MARK = "authority hitl";
const CATCH_ALL: Decision = {
  status: "failed",
  actual: CATCH_ALL_MARK,
  error: expect.any(String),
};
/** A rule that asks a battery helper, which offline replay leaves unanswered. */
const UNANSWERED_HELPER = {
  status: "cannot_run",
  actual: null,
  error: expect.stringMatching(/annotator=github\.repository-visibility /),
};
/** A call the replay ran no step for. */
const UNOPENED = {
  status: "cannot_run",
  actual: null,
  refusal: expect.any(String),
};
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

/** The builtins of a policy's annotators answered by model inference. */
function modelBuiltins(policy: string): string[] {
  const annotators = (
    parsePolicyToml(policy)?.policy as { annotator?: unknown } | undefined
  )?.annotator;
  return Array.isArray(annotators)
    ? annotators.flatMap(({ builtin }: { builtin?: unknown }) =>
        typeof builtin === "string" && builtin !== "archestra" ? [builtin] : [],
      )
    : [];
}

/**
 * The battery helper a rule's annotator runs, which offline replay leaves
 * unanswered, and the call arguments its audience templates read; null for a
 * rule decided without one.
 */
function ruleHelper(
  policies: string[],
  rule: string,
): { name: string; reads: string[] } | null {
  const annotator = policies
    .flatMap(toolEntries)
    .find(({ name }) => name === rule)?.annotator;
  if (typeof annotator !== "string") return null;
  const declarations = policies.map(
    (policy) =>
      parsePolicyToml(policy) as {
        policy?: { annotator?: { name?: unknown; audiences?: unknown }[] };
        externals?: { annotators?: Record<string, { command?: unknown }> };
      } | null,
  );
  if (
    !declarations.some((declaration) =>
      Array.isArray(declaration?.externals?.annotators?.[annotator]?.command),
    )
  )
    return null;
  const audiences = declarations.flatMap(
    (declaration) =>
      declaration?.policy?.annotator?.flatMap(({ name, audiences }) =>
        name === annotator && Array.isArray(audiences) ? audiences : [],
      ) ?? [],
  );
  return {
    name: annotator,
    reads: [
      ...new Set(
        audiences.flatMap((audience) =>
          typeof audience === "string"
            ? [...audience.matchAll(/\$(\w+)/g)].map(([, read]) => read)
            : [],
        ),
      ),
    ],
  };
}

/** The annotator a step's error names when its consult went unanswered. */
const UNANSWERED_ANNOTATOR = /annotator=(\S+) error=/;

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
    ) as {
      files: {
        path: string;
        status: string;
        error?: string;
        steps: { status: string; actual: string | null; error?: string }[];
      }[];
    };
    for (const file of response.files) {
      expect(file.steps.length).toBeLessThanOrEqual(1);
      const [step] = file.steps;
      decisions[start + Number.parseInt(file.path, 10)] = step
        ? {
            status: step.status,
            actual: step.actual,
            ...(step.error === undefined ? {} : { error: step.error }),
          }
        : { status: file.status, actual: null, refusal: file.error ?? "" };
    }
  }
  expect(Object.keys(decisions)).toHaveLength(calls.length);
  return decisions;
}

/**
 * A call a rule governs: its namespace, its tool, and the arguments its pattern
 * names, a wildcard taking any value. Null for a rule on no MCP server.
 */
function ruleCall(rule: string): {
  namespace: string;
  tool: string;
  pattern: [string, string][];
} | null {
  const match = /^mcp\/([^/]+)\/([^(]+)(?:\((.*)\))?$/.exec(rule);
  if (!match) return null;
  const [, namespace, tool, pattern] = match;
  return {
    namespace,
    tool,
    pattern: (pattern ?? "")
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const [key, value] = pair.split(":");
        return [key, value];
      }),
  };
}

/**
 * The calls the rules govern, and those they leave to the root. Each rule is
 * called with what its pattern matches. Each tool is called with no arguments,
 * and each patterned rule with arguments its pattern does not match: the
 * battery governs those only through a rule of the tool with no pattern.
 */
function governedCalls(rules: string[]) {
  const parsed = rules.flatMap((rule) => {
    const call = ruleCall(rule);
    return call ? [{ rule, ...call }] : [];
  });
  const unpatterned = new Set(
    parsed
      .filter(({ pattern }) => pattern.length === 0)
      .map(({ rule }) => rule),
  );
  const toolRule = (call: { namespace: string; tool: string }) => {
    const rule = `mcp/${call.namespace}/${call.tool}`;
    return unpatterned.has(rule) ? rule : null;
  };
  const matching = parsed.map((call) => ({
    label: `${call.rule} [matching]`,
    namespace: call.namespace,
    tool: call.tool,
    arguments: {
      ...ONE_REPOSITORY,
      ...Object.fromEntries(
        call.pattern.map(([key, value]) => [
          key,
          value === "*" ? "any" : value,
        ]),
      ),
    },
    rule: call.rule as string | null,
  }));
  const bare = [
    ...new Map(
      parsed.map((call) => [`${call.namespace}/${call.tool}`, call]),
    ).values(),
  ].map((call) => ({
    label: `mcp/${call.namespace}/${call.tool} [bare]`,
    namespace: call.namespace,
    tool: call.tool,
    arguments: {},
    rule: toolRule(call),
  }));
  const nonmatching = parsed
    .filter(({ pattern }) => pattern.length > 0)
    .map((call) => ({
      label: `${call.rule} [nonmatching]`,
      namespace: call.namespace,
      tool: call.tool,
      arguments: {
        ...ONE_REPOSITORY,
        ...Object.fromEntries(
          call.pattern
            .filter(([, value]) => value !== "*")
            .map(([key]) => [key, "matches-no-pattern"]),
        ),
      },
      rule: toolRule(call),
    }));
  return [...matching, ...bare, ...nonmatching];
}

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
