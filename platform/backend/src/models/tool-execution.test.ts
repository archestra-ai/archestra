import { describe, expect, test } from "@/test";
import ToolExecutionModel from "./tool-execution";

describe("ToolExecutionModel", () => {
  describe("claim", () => {
    test("first claim wins and records the executing state", async () => {
      const row = await ToolExecutionModel.claim("call_first");

      expect(row).not.toBeNull();
      expect(row?.toolCallId).toBe("call_first");
      expect(row?.state).toBe("executing");
    });

    test("a second claim on the same tool call id returns null", async () => {
      const first = await ToolExecutionModel.claim("call_dup");
      const second = await ToolExecutionModel.claim("call_dup");

      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    test("concurrent claims on the same id yield exactly one winner", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => ToolExecutionModel.claim("call_race")),
      );

      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
    });

    test("different tool call ids each win their own claim", async () => {
      const a = await ToolExecutionModel.claim("call_a");
      const b = await ToolExecutionModel.claim("call_b");

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  describe("complete / fail", () => {
    test("complete records the result and the completed state", async () => {
      await ToolExecutionModel.claim("call_ok");
      await ToolExecutionModel.complete("call_ok", { content: "done" });

      const row = await ToolExecutionModel.getByToolCallId("call_ok");
      expect(row?.state).toBe("completed");
      expect(row?.result).toEqual({ content: "done" });
    });

    test("fail records the error summary and the failed state", async () => {
      await ToolExecutionModel.claim("call_boom");
      await ToolExecutionModel.fail("call_boom", { error: "upstream boom" });

      const row = await ToolExecutionModel.getByToolCallId("call_boom");
      expect(row?.state).toBe("failed");
      expect(row?.result).toEqual({ error: "upstream boom" });
    });
  });

  describe("getByToolCallId", () => {
    test("returns null for an unknown tool call id", async () => {
      expect(await ToolExecutionModel.getByToolCallId("missing")).toBeNull();
    });
  });
});
