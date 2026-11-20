// @vitest-environment node
import { getArchestraToolShortName } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { collectArchestraToolInvalidations } from "./archestra-tool-invalidations";

const getToolShortName = (toolName: string) =>
  getArchestraToolShortName(toolName, { includeDefaultPrefix: true });

const publishPart = (overrides: Record<string, unknown> = {}) => ({
  type: "tool-archestra__publish_app",
  toolCallId: "call-1",
  state: "output-available",
  input: { appId: "app-1", scope: "org" },
  output: { id: "app-1", scope: "org", runUrl: "/a/app-1" },
  ...overrides,
});

const startRunPart = (overrides: Record<string, unknown> = {}) => ({
  type: "tool-archestra__start_run",
  state: "output-available",
  output: { session_id: "run-1" },
  ...overrides,
});

describe("collectArchestraToolInvalidations", () => {
  it("refreshes run sessions after a successful start_run in chat", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [startRunPart()],
        getToolShortName,
      }),
    ).toEqual([["agent-runs"]]);
  });

  it("refreshes the guardrails deployment after a policy update in chat", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          {
            type: "tool-archestra__update_guardrails_policy",
            state: "output-available",
            output: { revision: 1, enforcement: "on" },
          },
        ],
        getToolShortName,
      }),
    ).toEqual([["guardrails-deployment"]]);
  });

  it("refreshes validations and their run history after a validation save", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          {
            type: "tool-archestra__update_guardrails_validation",
            state: "output-available",
            output: {
              delivery: "revision",
              run: null,
              runError:
                "Too many Guardrails policy tests are running. Retry in a few seconds.",
              savedPaths: ["traces/check-0.appa"],
            },
          },
        ],
        getToolShortName,
      }),
    ).toEqual([["openappa-policy-tests"], ["openappa-policy-test-runs"]]);
  });

  it("refreshes run history after a direct or dispatched validation run", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          {
            type: "tool-archestra__run_openappa_policy_tests",
            state: "output-available",
            output: { files: [] },
          },
          {
            type: "tool-archestra__run_tool",
            state: "output-available",
            input: {
              tool_name: "archestra__run_openappa_policy_tests",
              tool_args: {},
            },
            output: { files: [] },
          },
        ],
        getToolShortName,
      }),
    ).toEqual([["openappa-policy-test-runs"]]);
  });

  it("refreshes validations after a save dispatched through run_tool", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          {
            type: "tool-archestra__run_tool",
            state: "output-available",
            input: {
              tool_name: "archestra__update_guardrails_validation",
              tool_args: {},
            },
            output: { delivery: "revision", run: null },
          },
        ],
        getToolShortName,
      }),
    ).toEqual([["openappa-policy-tests"], ["openappa-policy-test-runs"]]);
  });

  it("refreshes run sessions when start_run is dispatched through run_tool", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          startRunPart({
            type: "tool-archestra__run_tool",
            input: { tool_name: "archestra__start_run", tool_args: {} },
          }),
        ],
        getToolShortName,
      }),
    ).toEqual([["agent-runs"]]);
  });

  it("does not refresh run sessions for a refused start_run", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          startRunPart({
            output: {
              archestraError: { type: "generic", message: "not allowed" },
            },
          }),
        ],
        getToolShortName,
      }),
    ).toEqual([]);
  });

  it("invalidates the app caches for a successful publish_app result", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [{ type: "text", text: "Publishing your app…" }, publishPart()],
        getToolShortName,
      }),
    ).toEqual([["apps"], ["mcp-catalog"]]);
  });

  it("resolves dynamic-tool parts through their toolName field", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          {
            type: "dynamic-tool",
            toolName: "archestra__publish_app",
            state: "output-available",
            output: { id: "app-1", scope: "org" },
          },
        ],
        getToolShortName,
      }),
    ).toEqual([["apps"], ["mcp-catalog"]]);
  });

  it("dedupes query keys when a turn publishes twice", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [publishPart(), publishPart({ toolCallId: "call-2" })],
        getToolShortName,
      }),
    ).toEqual([["apps"], ["mcp-catalog"]]);
  });

  it("skips a call that never produced output (e.g. aborted mid-call)", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [publishPart({ state: "input-available", output: undefined })],
        getToolShortName,
      }),
    ).toEqual([]);
  });

  it("skips errored results — a refused publish mutated nothing", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          publishPart({ state: "output-error", errorText: "boom" }),
          publishPart({
            output: {
              archestraError: { type: "generic", message: "not allowed" },
            },
          }),
        ],
        getToolShortName,
      }),
    ).toEqual([]);
  });

  it("ignores non-mutating archestra tools and non-archestra tools", () => {
    expect(
      collectArchestraToolInvalidations({
        parts: [
          publishPart({ type: "tool-archestra__list_apps" }),
          publishPart({ type: "tool-slack__slack_send_message" }),
          publishPart({ type: "tool-publish_app" }), // no server prefix
        ],
        getToolShortName,
      }),
    ).toEqual([]);
  });

  it("handles messages without parts", () => {
    expect(
      collectArchestraToolInvalidations({ parts: undefined, getToolShortName }),
    ).toEqual([]);
  });
});
