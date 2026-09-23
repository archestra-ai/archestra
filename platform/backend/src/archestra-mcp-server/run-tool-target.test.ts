import { describe, expect, test } from "@/test";
import {
  resolveRunToolDispatch,
  resolveRunToolTarget,
  resolveUnprovenRunToolTarget,
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

describe("resolveUnprovenRunToolTarget", () => {
  // A wrapper whose declaration carries no effective attestation: the gateway
  // registered twice, a replayed marker, or a lookalike. Its target is ruled
  // on too, taken as written.
  test("names the target of a run_tool-shaped call in every client form", () => {
    for (const toolName of [
      "mcp__gw__archestra__run_tool",
      "gw_archestra__run_tool",
      "mcp__archestra__archestra__run_tool",
      // Bare, or a Codex member joined to its namespace.
      "archestra__run_tool",
    ]) {
      expect(
        resolveUnprovenRunToolTarget({
          toolName,
          args: {
            tool_name: "github__issue_write",
            tool_args: { title: "hello" },
          },
        }),
      ).toEqual({
        toolName: "github__issue_write",
        toolInput: { title: "hello" },
      });
    }
  });

  test("never names a built-in, and needs a usable target", () => {
    for (const args of [
      { tool_name: "whoami" },
      { tool_name: "archestra__whoami" },
      { tool_name: "" },
      { tool_args: {} },
      "not an object",
    ]) {
      expect(
        resolveUnprovenRunToolTarget({
          toolName: "mcp__gw__archestra__run_tool",
          args,
        }),
      ).toBeUndefined();
    }
  });

  test("does not read a third-party tool named run_tool as the wrapper", () => {
    for (const toolName of ["run_tool", "mcp__gw__github__run_tool"]) {
      expect(
        resolveUnprovenRunToolTarget({
          toolName,
          args: { tool_name: "github__issue_write" },
        }),
      ).toBeUndefined();
    }
  });
});
