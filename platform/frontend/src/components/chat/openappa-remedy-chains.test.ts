// @vitest-environment node
import type { UIMessage } from "@ai-sdk/react";
import { getArchestraToolShortName } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  getRemedyChainStatus,
  identifyRemedyChains,
  remedyChainPartIndices,
} from "./openappa-remedy-chains";

const NOTICE = "archestra__get_remedy_plans";
const REMEDY = "archestra__execute_remedy_plan";
const RUN_TOOL = "archestra__run_tool";

const getToolShortName = (toolName: string) =>
  getArchestraToolShortName(toolName, { includeDefaultPrefix: true });

describe("identifyRemedyChains", () => {
  it("merges a blocked call, its remedy, and the released retry", () => {
    const parts = [
      notice({ id: "c1", tool: "github__show_board", args: { id: 7 } }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      call({ id: "c3", toolName: "github__show_board", input: { id: 7 } }),
    ];

    const [chain, ...rest] = identifyRemedyChains(parts, { getToolShortName });

    expect(rest).toEqual([]);
    expect(chain.anchorIndex).toBe(0);
    expect(chain.targetToolName).toBe("github__show_board");
    expect(chain.targetArguments).toEqual({ id: 7 });
    expect(chain.steps.map((step) => step.part.toolCallId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(chain.finalAttempt?.part.toolCallId).toBe("c3");
    expect(getRemedyChainStatus(chain)).toEqual({
      state: "completed",
      label: undefined,
    });
  });

  it("merges a run_tool dispatch retried through the wrapper", () => {
    const parts = [
      notice({ id: "c1", tool: "archestra__list_skills", args: {} }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      call({
        id: "c3",
        toolName: RUN_TOOL,
        input: { tool_name: "archestra__list_skills", tool_args: {} },
      }),
    ];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.targetToolName).toBe("archestra__list_skills");
    expect(chain.finalAttempt?.toolName).toBe(RUN_TOOL);
  });

  it("reads JSON-string notice arguments as the object they hold", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: '{"path":"/a","n":1}' }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      call({ id: "c3", toolName: "fs__read", input: { n: 1, path: "/a" } }),
    ];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.targetArguments).toEqual({ path: "/a", n: 1 });
    expect(chain.finalAttempt?.part.toolCallId).toBe("c3");
  });

  it("reports a remedy the user denied, with no retry", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: {} }),
      remedy({ id: "c2", offerId: offerFor("c1"), humanRuling: "deny" }),
    ];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.finalAttempt).toBeNull();
    expect(getRemedyChainStatus(chain)).toEqual({
      state: "denied",
      label: "Denied by you",
    });
  });

  it("continues the chain when the retry is blocked again, then succeeds", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      notice({ id: "c3", tool: "fs__read", args: { p: 1 } }),
      remedy({ id: "c4", offerId: offerFor("c3") }),
      call({ id: "c5", toolName: "fs__read", input: { p: 1 } }),
    ];

    const chains = identifyRemedyChains(parts, { getToolShortName });

    expect(chains).toHaveLength(1);
    expect(chains[0].steps.map((step) => step.role)).toEqual([
      "notice",
      "remedy",
      "notice",
      "remedy",
    ]);
    expect(chains[0].finalAttempt?.part.toolCallId).toBe("c5");
  });

  it("keeps two blocked calls apart when their remedies interleave", () => {
    const parts = [
      notice({ id: "a1", tool: "fs__read", args: { p: "a" } }),
      notice({ id: "b1", tool: "web__fetch", args: { url: "b" } }),
      call({ id: "n1", toolName: "clock__now", input: {} }),
      remedy({ id: "b2", offerId: offerFor("b1") }),
      remedy({ id: "a2", offerId: offerFor("a1") }),
      call({ id: "b3", toolName: "web__fetch", input: { url: "b" } }),
      call({ id: "a3", toolName: "fs__read", input: { p: "a" } }),
    ];

    const chains = identifyRemedyChains(parts, { getToolShortName });

    expect(
      chains.map((chain) => ({
        anchor: chain.anchorIndex,
        members: [...chain.steps, chain.finalAttempt].map(
          (member) => member?.part.toolCallId,
        ),
      })),
    ).toEqual([
      { anchor: 0, members: ["a1", "a2", "a3"] },
      { anchor: 1, members: ["b1", "b2", "b3"] },
    ]);
    // The unrelated call belongs to no chain.
    expect(chains.flatMap(remedyChainPartIndices)).not.toContain(2);
  });

  it("leaves a remedy whose offer no ruling names as a normal call", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: {} }),
      remedy({ id: "c2", offerId: "ffffffffffffffff" }),
    ];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.steps.map((step) => step.part.toolCallId)).toEqual(["c1"]);
    expect(remedyChainPartIndices(chain)).toEqual([0]);
  });

  it("does not merge a retry with different arguments", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      call({ id: "c3", toolName: "fs__read", input: { p: 2 } }),
    ];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.finalAttempt).toBeNull();
    expect(getRemedyChainStatus(chain)).toEqual({
      state: "denied",
      label: "Blocked",
    });
  });

  it("reads a chain still streaming as running, with its result parts", () => {
    const parts = [
      ...splitCall(notice({ id: "c1", tool: "fs__read", args: {} })),
      {
        type: `tool-${REMEDY}`,
        toolCallId: "c2",
        state: "input-available",
        input: { offer_id: offerFor("c1"), plan: "Accept" },
      },
    ] as UIMessage["parts"];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.steps.map((step) => step.role)).toEqual(["notice", "remedy"]);
    expect(remedyChainPartIndices(chain)).toEqual([0, 1, 2]);
    expect(getRemedyChainStatus(chain)).toEqual({ state: "running" });
  });

  it("holds a retry still streaming its arguments in the chain it retries", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      {
        type: "tool-fs__read",
        toolCallId: "c3",
        state: "input-streaming",
        input: {},
      },
    ] as UIMessage["parts"];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.finalAttempt?.part.toolCallId).toBe("c3");
    expect(getRemedyChainStatus(chain).state).toBe("running");
  });

  it("splits a streamed retry out once its complete arguments differ", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      remedy({ id: "c2", offerId: offerFor("c1") }),
      {
        type: "tool-fs__read",
        toolCallId: "c3",
        state: "input-available",
        input: { p: 2 },
      },
    ] as UIMessage["parts"];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.finalAttempt).toBeNull();
    expect(remedyChainPartIndices(chain)).not.toContain(2);
  });

  it("does not hold a streaming call before the chain has a remedy", () => {
    const parts = [
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      {
        type: "tool-fs__read",
        toolCallId: "c2",
        state: "input-streaming",
        input: {},
      },
    ] as UIMessage["parts"];

    const [chain] = identifyRemedyChains(parts, { getToolShortName });

    expect(chain.finalAttempt).toBeNull();
  });

  it("keeps identical blocked calls of one step in separate chains", () => {
    const parts = [
      { type: "step-start" },
      notice({ id: "a1", tool: "fs__read", args: { p: 1 } }),
      notice({ id: "b1", tool: "fs__read", args: { p: 1 } }),
      { type: "step-start" },
      remedy({ id: "b2", offerId: offerFor("b1") }),
      remedy({ id: "a2", offerId: offerFor("a1") }),
      { type: "step-start" },
      call({ id: "r1", toolName: "fs__read", input: { p: 1 } }),
      call({ id: "r2", toolName: "fs__read", input: { p: 1 } }),
    ] as UIMessage["parts"];

    const chains = identifyRemedyChains(parts, { getToolShortName });

    expect(
      chains.map((chain) =>
        [...chain.steps, chain.finalAttempt].map(
          (member) => member?.part.toolCallId,
        ),
      ),
    ).toEqual([
      ["a1", "a2", "r1"],
      ["b1", "b2", "r2"],
    ]);
  });

  it("continues a chain when the call is blocked again in a later step", () => {
    const parts = [
      { type: "step-start" },
      notice({ id: "c1", tool: "fs__read", args: { p: 1 } }),
      { type: "step-start" },
      remedy({ id: "c2", offerId: offerFor("c1") }),
      { type: "step-start" },
      notice({ id: "c3", tool: "fs__read", args: { p: 1 } }),
    ] as UIMessage["parts"];

    const chains = identifyRemedyChains(parts, { getToolShortName });

    expect(chains).toHaveLength(1);
    expect(chains[0].steps.map((step) => step.part.toolCallId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });
});

// === Fixtures ===

/** The offer id a test ruling for `callId` names. */
function offerFor(callId: string): string {
  return Buffer.from(callId).toString("hex").padEnd(16, "0");
}

function notice(params: {
  id: string;
  tool: string;
  args: unknown;
}): UIMessage["parts"][number] {
  const ruling = `[appa] Blocked: ${params.tool} cannot run yet.\n  - ${REMEDY}(offer_id: "${offerFor(params.id)}", plan: "Accept")`;
  return {
    type: `tool-${NOTICE}`,
    toolCallId: params.id,
    state: "output-available",
    input: {
      tool: params.tool,
      arguments: params.args,
      ruling,
      notice: { v: 1, call_id: params.id },
    },
    output: ruling,
  } as UIMessage["parts"][number];
}

function remedy(params: {
  id: string;
  offerId: string;
  humanRuling?: "approve" | "deny";
}): UIMessage["parts"][number] {
  return {
    type: `tool-${REMEDY}`,
    toolCallId: params.id,
    state: "output-available",
    input: { offer_id: params.offerId, plan: "Accept" },
    output: {
      content: [{ type: "text", text: "[appa] Authorized." }],
      ...(params.humanRuling
        ? { _meta: { archestraHumanRuling: params.humanRuling } }
        : {}),
    },
  } as UIMessage["parts"][number];
}

function call(params: {
  id: string;
  toolName: string;
  input: unknown;
}): UIMessage["parts"][number] {
  return {
    type: `tool-${params.toolName}`,
    toolCallId: params.id,
    state: "output-available",
    input: params.input,
    output: "ok",
  } as UIMessage["parts"][number];
}

/** The streamed shape: the invocation, then a separate result part. */
function splitCall(
  part: UIMessage["parts"][number],
): UIMessage["parts"][number][] {
  const { output, ...invocation } = part as { output: unknown };
  return [
    { ...invocation, state: "input-available" },
    { ...part, state: "output-available", output },
  ] as UIMessage["parts"][number][];
}
