import { describe, expect, test } from "@/test";
import {
  LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
} from "./llm-proxy-plugin";

function requestContext(): LlmProxyRequestContext {
  return {
    requestId: "request-1",
    organizationId: "organization-1",
    profileId: "profile-1",
    provider: "openai",
    headers: {},
    requestBody: {},
    resources: new Map(),
  };
}

describe("LlmProxyPluginRegistry", () => {
  test("runs registered plugins in order and stops at a refusal", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "first",
      async onToolCalls() {
        events.push("first");
      },
    });
    registry.register({
      id: "deny",
      async onToolCalls() {
        events.push("deny");
        return { decision: "refuse", message: "blocked" };
      },
    });
    registry.register({
      id: "after-denial",
      async onToolCalls() {
        events.push("after-denial");
      },
    });

    await registry.onSessionInit(requestContext());
    await expect(
      registry.onToolCalls({ ...requestContext(), toolCalls: [] }),
    ).resolves.toEqual({ decision: "refuse", message: "blocked" });
    expect(events).toEqual(["first", "deny"]);
  });
});
