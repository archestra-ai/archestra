import { describe, expect, test } from "@/test";
import {
  formatResponsesFunctionCallFrames,
  rewriteResponsesOutput,
} from "./responses-tool-call-rewrite";

// Codex declares each MCP server's tools in a namespace and routes a call by
// the namespace it names: a rewritten call that loses it comes back from the
// client as "unsupported call".
describe("Responses tool-call rewrite", () => {
  const notice = {
    id: "call_1",
    name: "archestra__get_remedy_plans",
    arguments: "{}",
    namespace: "mcp__my_gateway",
  };

  test("streams a rewritten call with its namespace", () => {
    let sequence = 0;
    const frames = formatResponsesFunctionCallFrames({
      toolCalls: [notice],
      firstOutputIndex: 0,
      nextSequenceNumber: () => sequence++,
    }).map((frame) => JSON.parse(frame.replace(/^data: /, "").trim()));

    const done = frames.find(
      (frame) => frame.type === "response.output_item.done",
    );
    expect(done.item).toMatchObject({
      name: "archestra__get_remedy_plans",
      namespace: "mcp__my_gateway",
    });
    const added = frames.find(
      (frame) => frame.type === "response.output_item.added",
    );
    expect(added.item.namespace).toBe("mcp__my_gateway");
  });

  test("replaces a call in place with the rewritten call's namespace", () => {
    const output = rewriteResponsesOutput(
      [
        {
          type: "function_call",
          call_id: "call_1",
          name: "spawn_agent",
          arguments: "{}",
          namespace: "multi_agent_v1",
        },
      ],
      [notice],
    );

    expect(output).toEqual([
      expect.objectContaining({
        call_id: "call_1",
        name: "archestra__get_remedy_plans",
        namespace: "mcp__my_gateway",
      }),
    ]);
  });

  test("replaces a namespaced call with a signed local call", () => {
    const localQuestion = {
      id: "call_1",
      wireId: "call_aq1_signed",
      name: "request_user_input",
      arguments: '{"questions":[]}',
      namespace: "",
    };
    const output = rewriteResponsesOutput(
      [
        {
          type: "function_call",
          call_id: "call_1",
          name: "archestra__ask_user",
          arguments: "{}",
          namespace: "mcp__my_gateway",
        },
      ],
      [localQuestion],
    );
    const frames = formatResponsesFunctionCallFrames({
      toolCalls: [localQuestion],
      firstOutputIndex: 0,
      nextSequenceNumber: () => 0,
      namespaceByCallId: new Map([["call_1", "mcp__my_gateway"]]),
    }).map((frame) => JSON.parse(frame.replace(/^data: /, "").trim()));

    expect(output).toEqual([
      expect.objectContaining({
        call_id: "call_aq1_signed",
        name: "request_user_input",
      }),
    ]);
    expect(output[0]).not.toHaveProperty("namespace");
    expect(frames.at(-1)?.item).toMatchObject({
      call_id: "call_aq1_signed",
      name: "request_user_input",
    });
    expect(frames.at(-1)?.item).not.toHaveProperty("namespace");
  });

  test("rewrites a denied custom tool call to a notice without the denied namespace", () => {
    const notice = {
      id: "call_custom",
      name: "archestra__get_remedy_plans",
      arguments: "{}",
    };
    const output = rewriteResponsesOutput(
      [
        {
          type: "custom_tool_call",
          call_id: "call_custom",
          name: "apply_patch",
          input: "diff",
          namespace: "mcp__my_gateway",
        },
      ],
      [notice],
    );

    expect(output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_custom",
        name: "archestra__get_remedy_plans",
      }),
    ]);
    expect(output[0]).not.toHaveProperty("namespace");
  });
});
