/**
 * Frontend scenario-matrix sweep. Runs every entry in `CASCADE_SCENARIOS`
 * through the pure `computeCascadeOutcome` function and asserts the
 * outcome matches the scenario's `expected`.
 *
 * The pure function is what the form's `handleSubmit` actually calls —
 * so this test is the frontend's authoritative end-to-end check
 * without needing a jsdom render. Same shape as the backend's
 * `cascade scenarios — backend full-outcome sweep`.
 *
 * If a scenario fails here but passes on the backend (or vice versa),
 * the frontend and backend cascade decisions have diverged — that's
 * exactly the kind of bug the contract is designed to prevent.
 */

import {
  CASCADE_SCENARIOS,
  CATALOG_SHAPES,
  SERVER_NAME_PLACEHOLDER,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import {
  type CascadeSnapshot,
  computeCascadeOutcome,
  promptedEnvVarsChanged,
  requiredUserConfigChanged,
  userConfigChangedBreakingly,
} from "./cascade-decision";

describe("cascade scenarios — frontend full-outcome sweep", () => {
  test.each(
    CASCADE_SCENARIOS,
  )("$id full cascade decision ($expected): $userAction", (scenario) => {
    const prev = CATALOG_SHAPES[scenario.shape] as unknown as CascadeSnapshot;
    const next = scenario.edit(
      CATALOG_SHAPES[scenario.shape],
    ) as unknown as CascadeSnapshot;

    // The form passes `affectedServerCount > 0` for any non-empty
    // install set; the exact count doesn't influence the decision
    // (it only feeds the bar's copy). All scenarios assume at least
    // one install — there's no point cascading otherwise.
    const outcome = computeCascadeOutcome(prev, next, {
      affectedServerCount: 1,
    });

    // `frontendBar` is a permanent, by-design divergence from the
    // backend path; `knownFrontendOverride` is a temporary bug marker.
    const frontendExpected =
      scenario.frontendBar ??
      scenario.knownFrontendOverride?.actual ??
      scenario.expected;
    expect(outcome.mode).toBe(frontendExpected);
    // None of the matrix scenarios rename — the rename decisions have
    // their own describe below.
    expect(outcome.renamed).toBe(false);
  });
});

describe("computeCascadeOutcome — rename decisions", () => {
  const local = (over: Partial<CascadeSnapshot> = {}): CascadeSnapshot => ({
    name: "old-name",
    serverType: "local",
    localConfig: { command: "node", arguments: ["server.js"], environment: [] },
    ...over,
  });

  test("pure rename → 'rename' (DB-only cascade, client-reload warning)", () => {
    expect(
      computeCascadeOutcome(local(), local({ name: "new-name" }), {
        affectedServerCount: 1,
      }),
    ).toEqual({ mode: "rename", renamed: true });
  });

  test("remote rename is no longer 'skip' — remote tools re-slug through the same cascade", () => {
    const remote = (over: Partial<CascadeSnapshot> = {}): CascadeSnapshot => ({
      name: "old-name",
      serverType: "remote",
      serverUrl: "https://api.example.com",
      ...over,
    });
    expect(
      computeCascadeOutcome(remote(), remote({ name: "new-name" }), {
        affectedServerCount: 1,
      }),
    ).toEqual({ mode: "rename", renamed: true });
  });

  test("rename on a catalog whose deploymentSpecYaml uses the serverName placeholder → 'manual'", () => {
    const withYaml = local({
      deploymentSpecYaml: `metadata:\n  labels:\n    mcp-server-name: ${SERVER_NAME_PLACEHOLDER}\n`,
    });
    expect(
      computeCascadeOutcome(
        withYaml,
        // transformFormToApiData never carries the YAML — prev's value is
        // authoritative (mirrors the real form submit).
        { ...local(), name: "new-name", deploymentSpecYaml: undefined },
        { affectedServerCount: 1 },
      ),
    ).toEqual({ mode: "manual", renamed: true });
  });

  test("rename combined with a breaking command change → 'manual' with the renamed flag riding along", () => {
    const next = local({
      name: "new-name",
      localConfig: {
        command: "bun",
        arguments: ["server.js"],
        environment: [],
      },
    });
    expect(
      computeCascadeOutcome(local(), next, { affectedServerCount: 1 }),
    ).toEqual({ mode: "manual", renamed: true });
  });

  test("rename with zero installs → 'skip' (no connected clients to warn)", () => {
    expect(
      computeCascadeOutcome(local(), local({ name: "new-name" }), {
        affectedServerCount: 0,
      }),
    ).toEqual({ mode: "skip", renamed: true });
  });
});

describe("computeCascadeOutcome — remote auto path saves without a bar", () => {
  const remote = (over: Partial<CascadeSnapshot> = {}): CascadeSnapshot => ({
    name: "linear",
    serverType: "remote",
    serverUrl: "https://api.example.com/mcp",
    oauthConfig: { clientId: "abc", scopes: ["read"] },
    userConfig: {},
    ...over,
  });

  test("serverUrl change → 'skip' (backend re-syncs tools in the background; nothing restarts)", () => {
    expect(
      computeCascadeOutcome(
        remote(),
        remote({ serverUrl: "https://api.example.com/mcp/v2" }),
        { affectedServerCount: 3 },
      ),
    ).toEqual({ mode: "skip", renamed: false });
  });

  test("oauthConfig content change (OAuth present on both sides) → 'skip'", () => {
    expect(
      computeCascadeOutcome(
        remote(),
        remote({
          oauthConfig: {
            clientId: "abc",
            scopes: ["read"],
            protectedResource: "https://api.example.com",
          },
        }),
        { affectedServerCount: 1 },
      ),
    ).toEqual({ mode: "skip", renamed: false });
  });

  test("breaking change + rename → 'rename' (clients must still reload renamed tools)", () => {
    expect(
      computeCascadeOutcome(
        remote(),
        remote({
          name: "linear-v2",
          serverUrl: "https://api.example.com/mcp/v2",
        }),
        { affectedServerCount: 2 },
      ),
    ).toEqual({ mode: "rename", renamed: true });
  });
});

describe("computeCascadeOutcome — remote manual paths survive the no-bar auto rule", () => {
  const remote = (over: Partial<CascadeSnapshot> = {}): CascadeSnapshot => ({
    name: "linear",
    serverType: "remote",
    serverUrl: "https://api.example.com/mcp",
    oauthConfig: null,
    userConfig: {},
    ...over,
  });

  test("OAuth added → 'manual' (auth model flips; installs must re-authenticate)", () => {
    expect(
      computeCascadeOutcome(
        remote(),
        remote({ oauthConfig: { clientId: "abc" } }),
        { affectedServerCount: 1 },
      ).mode,
    ).toBe("manual");
  });

  test("required userConfig field added → 'manual' (install must supply a value)", () => {
    expect(
      computeCascadeOutcome(
        remote(),
        remote({
          userConfig: {
            api_key: { type: "string", required: true },
          },
        }),
        { affectedServerCount: 1 },
      ).mode,
    ).toBe("manual");
  });
});

// ─── Tripwires for the leaf predicates that drive the manual path.
//     These guard against direct regressions in the building blocks,
//     separate from the full-outcome sweep above.

const env = (overrides: Record<string, unknown> = {}): CascadeSnapshot => ({
  serverType: "local",
  localConfig: {
    command: "node",
    arguments: ["server.js"],
    environment: [],
    ...overrides,
  },
});

describe("promptedEnvVarsChanged — manual-path leaf predicate", () => {
  test("identical → false", () => {
    const arr = [
      { key: "X", type: "secret", promptOnInstallation: true, required: false },
    ];
    expect(
      promptedEnvVarsChanged(
        env({ environment: arr }),
        env({ environment: [...arr] }),
      ),
    ).toBe(false);
  });
  test("added optional prompted var → false (forward-compatible)", () => {
    expect(
      promptedEnvVarsChanged(
        env({ environment: [] }),
        env({
          environment: [
            {
              key: "NEW",
              type: "plain_text",
              promptOnInstallation: true,
              required: false,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  test("added required prompted var → true", () => {
    expect(
      promptedEnvVarsChanged(
        env({ environment: [] }),
        env({
          environment: [
            {
              key: "NEW",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
  test("removed prompted var → true", () => {
    expect(
      promptedEnvVarsChanged(
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: false,
            },
          ],
        }),
        env({ environment: [] }),
      ),
    ).toBe(true);
  });
  test("required false → true → true", () => {
    expect(
      promptedEnvVarsChanged(
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: false,
            },
          ],
        }),
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
  test("required true → false → false (forward-compatible)", () => {
    expect(
      promptedEnvVarsChanged(
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: true,
            },
          ],
        }),
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: false,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
  test("`mounted` flip on existing prompted var → false (not a schema change)", () => {
    // The schema-evolution check is intentionally lenient about
    // `mounted` (no re-prompt needed). The runtime-only check below
    // catches it for the auto path. See full-cascade test for that.
    expect(
      promptedEnvVarsChanged(
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: false,
              mounted: false,
            },
          ],
        }),
        env({
          environment: [
            {
              key: "X",
              type: "secret",
              promptOnInstallation: true,
              required: false,
              mounted: true,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("computeCascadeOutcome — `mounted` flip routes to auto, not manual", () => {
  test("flipping mounted on an existing prompted secret env var → auto", () => {
    const base = env({
      environment: [
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
          mounted: false,
        },
      ],
    });
    const flipped = env({
      environment: [
        {
          key: "API_KEY",
          type: "secret",
          promptOnInstallation: true,
          required: false,
          mounted: true,
        },
      ],
    });
    // Re-import here from the module to exercise the full pipeline,
    // not just the leaf predicate — verifies the gate routes mounted
    // changes through `onlyForwardCompatibleDiff` returning false →
    // auto, NOT the manual path.
    expect(
      computeCascadeOutcome(base, flipped, {
        affectedServerCount: 1,
      }).mode,
    ).toBe("auto");
  });
});

describe("requiredUserConfigChanged — manual-path leaf predicate", () => {
  test("only optional fields → false", () => {
    expect(
      requiredUserConfigChanged(
        {
          userConfig: {
            h1: { type: "string", required: false, headerName: "x-h1" },
          },
        },
        {
          userConfig: {
            h1: { type: "string", required: false, headerName: "x-h1" },
            h2: { type: "string", required: false, headerName: "x-h2" },
          },
        },
      ),
    ).toBe(false);
  });
  test("added required field → true", () => {
    expect(
      requiredUserConfigChanged(
        { userConfig: {} },
        {
          userConfig: {
            r1: { type: "string", required: true, headerName: "x-r1" },
          },
        },
      ),
    ).toBe(true);
  });
  test("required field type change → true", () => {
    expect(
      requiredUserConfigChanged(
        {
          userConfig: {
            r1: { type: "string", required: true, headerName: "x-r1" },
          },
        },
        {
          userConfig: {
            r1: { type: "number", required: true, headerName: "x-r1" },
          },
        },
      ),
    ).toBe(true);
  });
  test("demoted required → optional (same field) → false (forward-compat)", () => {
    // The existing install supplied a value when the field was required.
    // After demotion the install's value is still valid; no re-prompt
    // needed. (The pod doesn't need to restart for this either — the
    // field's stored value continues to flow through.)
    expect(
      requiredUserConfigChanged(
        {
          userConfig: {
            r1: { type: "string", required: true, headerName: "x-r1" },
          },
        },
        {
          userConfig: {
            r1: { type: "string", required: false, headerName: "x-r1" },
          },
        },
      ),
    ).toBe(false);
  });
  test("entirely removed required field → false (no re-prompt; auto path catches the cleanup)", () => {
    // Field key is gone from userConfig altogether. The user has nothing
    // to re-supply — the field doesn't exist anymore. The install's
    // stored value becomes orphaned, but that's an auto-path concern:
    // `userConfigChangedBreakingly` flags the removal and the cascade
    // restarts the pod so the orphaned value stops being injected.
    expect(
      requiredUserConfigChanged(
        {
          userConfig: {
            r1: { type: "string", required: true, headerName: "x-r1" },
          },
        },
        { userConfig: {} },
      ),
    ).toBe(false);
  });
  test("promoted optional → required → true (existing install missing it)", () => {
    expect(
      requiredUserConfigChanged(
        {
          userConfig: {
            r1: { type: "string", required: false, headerName: "x-r1" },
          },
        },
        {
          userConfig: {
            r1: { type: "string", required: true, headerName: "x-r1" },
          },
        },
      ),
    ).toBe(true);
  });
});

describe("userConfigChangedBreakingly — forward-compat leaf predicate", () => {
  test("identical → false", () => {
    const uc = {
      h1: {
        type: "string",
        required: false,
        headerName: "x-h1",
        sensitive: false,
      },
    };
    expect(userConfigChangedBreakingly(uc, { ...uc })).toBe(false);
  });
  test("added optional header → false", () => {
    expect(
      userConfigChangedBreakingly(
        {},
        {
          new_opt: {
            type: "string",
            required: false,
            headerName: "x-new",
            sensitive: false,
          },
        },
      ),
    ).toBe(false);
  });
  test("added required header → true", () => {
    expect(
      userConfigChangedBreakingly(
        {},
        {
          new_req: {
            type: "string",
            required: true,
            headerName: "x-new",
            sensitive: false,
          },
        },
      ),
    ).toBe(true);
  });
  test("removed header → true", () => {
    expect(
      userConfigChangedBreakingly(
        {
          h1: {
            type: "string",
            required: false,
            headerName: "x-h1",
            sensitive: false,
          },
        },
        {},
      ),
    ).toBe(true);
  });
  test("required false → true → true", () => {
    expect(
      userConfigChangedBreakingly(
        {
          h1: {
            type: "string",
            required: false,
            headerName: "x-h1",
            sensitive: false,
          },
        },
        {
          h1: {
            type: "string",
            required: true,
            headerName: "x-h1",
            sensitive: false,
          },
        },
      ),
    ).toBe(true);
  });
  test("headerName change → true", () => {
    expect(
      userConfigChangedBreakingly(
        {
          h1: {
            type: "string",
            required: false,
            headerName: "x-h1",
            sensitive: false,
          },
        },
        {
          h1: {
            type: "string",
            required: false,
            headerName: "x-renamed",
            sensitive: false,
          },
        },
      ),
    ).toBe(true);
  });
  test("static header `default` value change → true (it's the runtime header)", () => {
    const base = {
      type: "string",
      required: false,
      headerName: "x-region",
      sensitive: false,
      promptOnInstallation: false,
    };
    expect(
      userConfigChangedBreakingly(
        { h1: { ...base, default: "us-east-1" } },
        { h1: { ...base, default: "eu-west-1" } },
      ),
    ).toBe(true);
  });
  test("prompted header `default` value change → false (just a placeholder)", () => {
    const base = {
      type: "string",
      required: false,
      headerName: "x-api-key",
      sensitive: false,
      promptOnInstallation: true,
    };
    expect(
      userConfigChangedBreakingly(
        { h1: { ...base, default: "placeholder-a" } },
        { h1: { ...base, default: "placeholder-b" } },
      ),
    ).toBe(false);
  });
});

// Regression: `prev` comes from the catalog API (extra fields like id,
// organizationId, createdAt, repository, ...) while `next` is built by
// `transformFormToApiData` (smaller field set). The shape mismatch
// must not be interpreted as a non-forward-compatible diff —
// otherwise every description-only edit on a real catalog item
// over-cascades.
describe("API-shape prev vs transform-shape next — shape-mismatch regression", () => {
  const apiPrev = {
    // API-only fields the form's transform output never includes:
    id: "00b04c99-3cc7-4431-ad85-b823662aada9",
    organizationId: "org-1",
    authorId: "user-1",
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    repository: "https://example.com/repo",
    instructions: "Use this for X",
    version: "1.0.0",
    requiresAuth: true,
    toolCount: 3,
    teams: [],
    // Fields the transform output also has:
    name: "Test1",
    description: "old description",
    serverType: "remote",
    multitenant: false,
    serverUrl: "https://api.example.com",
    authMethod: "none",
    authHeaderName: "",
    includeBearerPrefix: false,
    oauthConfig: null,
    enterpriseManagedConfig: null,
    localConfig: null,
    userConfig: {},
    icon: null,
    labels: [],
    scope: "org",
  } as unknown as CascadeSnapshot;

  test("description-only edit → skip (was 'auto' before fix)", () => {
    // What transformFormToApiData would produce after the user changed
    // only the description — strictly the API-input field set, missing
    // all the API-only metadata.
    const transformedNext: CascadeSnapshot = {
      name: "Test1",
      description: "new description",
      serverType: "remote",
      multitenant: false,
      serverUrl: "https://api.example.com",
      authMethod: "none",
      authHeaderName: "",
      includeBearerPrefix: false,
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      userConfig: {},
    };
    expect(
      computeCascadeOutcome(apiPrev, transformedNext, {
        affectedServerCount: 3,
      }).mode,
    ).toBe("skip");
  });

  test("icon-only edit → skip", () => {
    const transformedNext: CascadeSnapshot = {
      name: "Test1",
      description: "old description",
      serverType: "remote",
      multitenant: false,
      serverUrl: "https://api.example.com",
      authMethod: "none",
      authHeaderName: "",
      includeBearerPrefix: false,
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      userConfig: {},
      // The icon picker is the only field that changed:
      icon: "lucide:globe",
    };
    expect(
      computeCascadeOutcome(apiPrev, transformedNext, {
        affectedServerCount: 3,
      }).mode,
    ).toBe("skip");
  });

  test("serverUrl edit on this remote catalog → 'skip' (breaking diff detected, but remote saves without a bar)", () => {
    const transformedNext: CascadeSnapshot = {
      name: "Test1",
      description: "old description",
      serverType: "remote",
      multitenant: false,
      serverUrl: "https://NEW-api.example.com",
      authMethod: "none",
      authHeaderName: "",
      includeBearerPrefix: false,
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: null,
      userConfig: {},
    };
    expect(
      computeCascadeOutcome(apiPrev, transformedNext, {
        affectedServerCount: 3,
      }).mode,
    ).toBe("skip");
  });

  test("envFrom edit on a local catalog still triggers auto (sanity check the projection isn't too loose)", () => {
    const localPrev = {
      ...apiPrev,
      serverType: "local",
      serverUrl: null,
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        envFrom: [],
      },
    } as unknown as CascadeSnapshot;
    const transformedNext: CascadeSnapshot = {
      name: "Test1",
      description: "old description",
      serverType: "local",
      multitenant: false,
      serverUrl: null,
      authMethod: "none",
      authHeaderName: "",
      includeBearerPrefix: false,
      oauthConfig: null,
      enterpriseManagedConfig: null,
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [],
        envFrom: [{ type: "secret", name: "shared-creds" }],
      },
      userConfig: {},
    };
    expect(
      computeCascadeOutcome(localPrev, transformedNext, {
        affectedServerCount: 3,
      }).mode,
    ).toBe("auto");
  });
});
