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

  it("stamps the attachments marker only when files were stashed", () => {
    const without = new URLSearchParams(
      buildProjectChatHandoffUrl({
        projectId: "proj-1",
        prompt: "hi",
        agentId: "agent-42",
      }).split("?")[1],
    );
    expect(without.get("attachments")).toBeNull();

    const withFiles = new URLSearchParams(
      buildProjectChatHandoffUrl({
        projectId: "proj-1",
        prompt: "hi",
        agentId: "agent-42",
        hasAttachments: true,
      }).split("?")[1],
    );
    expect(withFiles.get("attachments")).toBe("1");
  });

  it("omits the empty prompt param for a files-only handoff", () => {
    // No caption: the attachments marker is what triggers the send on /chat, so
    // an empty user_prompt would just be noise (and reads as falsy there).
    const params = new URLSearchParams(
      buildProjectChatHandoffUrl({
        projectId: "proj-1",
        prompt: "",
        agentId: "agent-42",
        hasAttachments: true,
      }).split("?")[1],
    );
    expect(params.has("user_prompt")).toBe(false);
    expect(params.get("attachments")).toBe("1");
    expect(params.get("agentId")).toBe("agent-42");
  });
});
