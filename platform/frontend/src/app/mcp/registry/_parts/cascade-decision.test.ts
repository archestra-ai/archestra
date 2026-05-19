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

import { CASCADE_SCENARIOS, CATALOG_SHAPES } from "@shared";
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
    //
    // `labelsChanged` is computed by the form from its labels state.
    // None of the current scenarios touch labels, so it's always false
    // here. A future label-only scenario would set this to true.
    const outcome = computeCascadeOutcome(prev, next, {
      affectedServerCount: 1,
      labelsChanged: false,
    });

    const frontendExpected =
      scenario.knownFrontendOverride?.actual ?? scenario.expected;
    expect(outcome).toBe(frontendExpected);
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
});
