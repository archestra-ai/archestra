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

describe("collectArchestraToolInvalidations", () => {
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
