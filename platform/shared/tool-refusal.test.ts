import { describe, expect, test } from "vitest";
import {
  ARCHESTRA_TOOL_ARGUMENTS_TAG,
  ARCHESTRA_TOOL_NAME_TAG,
  ARCHESTRA_TOOL_REASON_TAG,
  buildArchestraToolRefusalMetadata,
  parseArchestraToolRefusal,
} from "./tool-refusal";

describe("tool refusal helpers", () => {
  test("builds and parses tagged refusal metadata", () => {
    const metadata = buildArchestraToolRefusalMetadata({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: "Tool invocation blocked: untrusted data detected",
    });

    expect(metadata).toContain(`<${ARCHESTRA_TOOL_NAME_TAG}>`);
    expect(metadata).toContain(`<${ARCHESTRA_TOOL_ARGUMENTS_TAG}>`);
    expect(metadata).toContain(`<${ARCHESTRA_TOOL_REASON_TAG}>`);

    expect(parseArchestraToolRefusal(metadata)).toEqual({
      toolName: "github__delete_branch",
      toolArguments: '{"branch":"main"}',
      reason: "Tool invocation blocked: untrusted data detected",
    });
  });

  test("ignores oversized refusal metadata payloads", () => {
    const oversizedInput = `${"<archestra-tool-name>x".repeat(5_000)}</archestra-tool-name>`;

    expect(parseArchestraToolRefusal(oversizedInput)).toEqual({
      toolName: undefined,
      toolArguments: undefined,
      reason: undefined,
    });
  });
});
