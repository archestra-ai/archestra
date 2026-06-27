import { describe, expect, it } from "vitest";
import { buildProjectChatHandoffUrl } from "./project-chat-handoff";

describe("buildProjectChatHandoffUrl", () => {
  it("forwards the selected agent so the project chat respects it", () => {
    // Regression guard: the project handoff previously omitted agentId, so the
    // /chat resolution chain fell back to the org default / saved pick instead
    // of the agent chosen in the project composer.
    const url = buildProjectChatHandoffUrl({
      projectId: "proj-1",
      prompt: "hello",
      agentId: "agent-42",
    });

    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("agentId")).toBe("agent-42");
    expect(params.get("project")).toBe("proj-1");
  });

  it("round-trips a prompt with special characters", () => {
    const prompt = "summarize: a & b? c=d #1";
    const url = buildProjectChatHandoffUrl({
      projectId: "proj-1",
      prompt,
      agentId: "agent-42",
    });

    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("user_prompt")).toBe(prompt);
  });

  it("targets the /chat route", () => {
    const url = buildProjectChatHandoffUrl({
      projectId: "proj-1",
      prompt: "hi",
      agentId: "agent-42",
    });

    expect(url.startsWith("/chat?")).toBe(true);
  });
});
