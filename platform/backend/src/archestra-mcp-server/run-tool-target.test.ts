import { describe, expect, test } from "vitest";
import { resolveRunToolTarget } from "./run-tool-target";

describe("resolveRunToolTarget", () => {
  // Policies rule on the arguments run_tool will run, and some models send
  // tool_args as JSON text that run_tool reads as an object.
  test("reads the target's arguments as run_tool does", () => {
    const target = { path: "notes.md", content: '{"a": 1}' };
    const toolInputOf = (toolArgs: unknown) =>
      resolveRunToolTarget("archestra__run_tool", {
        tool_name: "archestra__save_file",
        tool_args: toolArgs,
      }).toolInput;
    for (const toolArgs of [target, JSON.stringify(target)]) {
      expect(toolInputOf(toolArgs)).toEqual(target);
    }
    // run_tool runs a call without tool_args with no arguments, and refuses
    // the others, so the target has no arguments to rule on.
    for (const toolArgs of [undefined, "not json", "[1]", '"{}"', null]) {
      expect(toolInputOf(toolArgs)).toEqual({});
    }
  });
});
