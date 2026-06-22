import { TOOL_API_FULL_NAME } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { executeArchestraTool } from ".";
import type { ArchestraContext } from "./types";

describe("archestra__api tool", () => {
  test("refuses to run without a user context (autonomous session)", async () => {
    const context: ArchestraContext = {
      agent: { id: "agent-1", name: "Test Agent" },
      organizationId: "org-1",
      // no userId — e.g. an org/team-token autonomous session
    };

    const result = await executeArchestraTool(
      TOOL_API_FULL_NAME,
      { method: "GET", path: "/api/agents" },
      context,
    );

    expect(result.isError).toBe(true);
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(content.text).toContain("authenticated user context");
  });

  test("rejects auth-skipping paths outside the API surface", async () => {
    const context: ArchestraContext = {
      agent: { id: "agent-1", name: "Test Agent" },
      userId: "user-1",
      organizationId: "org-1",
    };

    // /v1/* proxy routes skip auth — they must not be reachable via this tool.
    const result = await executeArchestraTool(
      TOOL_API_FULL_NAME,
      { method: "POST", path: "/v1/openai/chat/completions" },
      context,
    );

    expect(result.isError).toBe(true);
    const [content] = result.content as Array<{ type: string; text: string }>;
    expect(content.text).toContain("/api/");
  });

  test("rejects traversal that resolves outside the API surface", async () => {
    const context: ArchestraContext = {
      agent: { id: "agent-1", name: "Test Agent" },
      userId: "user-1",
      organizationId: "org-1",
    };

    // Fastify normalizes these to /v1/* during routing, so the raw-string
    // allowlist alone would let them through. The canonical-path check must not.
    const bypassPaths = [
      "/api/../v1/openai/chat/completions",
      "/api/%2e%2e/v1/openai/chat/completions",
      "/api/%2E%2E/v1/openai/chat/completions",
      "/api/x%3f/../../v1/openai/chat/completions",
      "/api/./../v1/openai/chat/completions",
    ];

    for (const path of bypassPaths) {
      const result = await executeArchestraTool(
        TOOL_API_FULL_NAME,
        { method: "POST", path },
        context,
      );

      expect(result.isError, `expected ${path} to be rejected`).toBe(true);
      const [content] = result.content as Array<{ type: string; text: string }>;
      expect(content.text).toContain("/api/");
    }
  });
});
