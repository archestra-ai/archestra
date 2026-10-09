import { describe, expect, test } from "vitest";
import {
  resolveRunToolDispatch,
  resolveRunToolTarget,
} from "./run-tool-target";

describe("resolveRunToolDispatch", () => {
  const args = { tool_name: "whoami", tool_args: {} };

  test("is strict by default: only the platform's own wrapper name unwraps", () => {
    expect(
      resolveRunToolDispatch({ toolName: "archestra__run_tool", args }),
    ).toEqual({ kind: "target", toolName: "archestra__whoami" });
    // Behind a client label, nothing proves the wrapper is ours; the gateway
    // tool identity resolves a real one to its canonical name before this.
    for (const toolName of [
      "mcp__any_alias__archestra__run_tool",
      "any_alias_archestra__run_tool",
    ]) {
      expect(resolveRunToolDispatch({ toolName, args })).toEqual({
        kind: "not_dispatch",
      });
    }
  });

  test("a loose match hands its target to evaluation as written", () => {
    for (const toolName of [
      "mcp__any_alias__archestra__run_tool",
      "any_alias_archestra__run_tool",
    ]) {
      expect(
        resolveRunToolDispatch({
          toolName,
          args: { tool_name: "grain__list", tool_args: {} },
          loose: true,
        }),
      ).toEqual({ kind: "target", toolName: "grain__list", loose: true });
    }
    // A strict match stays strict with the loose scan on.
    expect(
      resolveRunToolDispatch({
        toolName: "archestra__run_tool",
        args,
        loose: true,
      }),
    ).toEqual({ kind: "target", toolName: "archestra__whoami" });
  });

  test("a loose match never yields a built-in target", () => {
    // A lookalike wrapper naming one of our built-ins, bare or branded, would
    // otherwise hand that built-in's policy bypass to whatever it runs.
    for (const target of ["whoami", "archestra__whoami"]) {
      const call = {
        toolName: "mcp__evil__archestra__run_tool",
        args: { tool_name: target, tool_args: {} },
        loose: true,
      };
      expect(resolveRunToolDispatch(call)).toEqual({ kind: "not_dispatch" });
      expect(resolveRunToolTarget(call)).toEqual({
        toolName: "mcp__evil__archestra__run_tool",
        toolInput: call.args,
      });
    }
  });

  test("an unusable target is unresolved, strict or loose", () => {
    expect(
      resolveRunToolDispatch({ toolName: "archestra__run_tool", args: {} }),
    ).toEqual({ kind: "unresolved" });
    expect(
      resolveRunToolDispatch({
        toolName: "mcp__gw__archestra__run_tool",
        args: { tool_name: "" },
        loose: true,
      }),
    ).toEqual({ kind: "unresolved" });
    expect(
      resolveRunToolDispatch({
        toolName: "archestra__run_tool",
        args: {
          tool_name: "Agent Runtime Handoff",
          tool_args: { action: "spawn" },
        },
      }),
    ).toEqual({ kind: "unresolved" });
  });

  test("does not mistake a third-party tool named run_tool for the wrapper", () => {
    for (const toolName of [
      "run_tool",
      "github__run_tool",
      "any_alias_run_tool",
    ]) {
      for (const loose of [false, true]) {
        expect(resolveRunToolDispatch({ toolName, args, loose })).toEqual({
          kind: "not_dispatch",
        });
      }
    }
  });
});
