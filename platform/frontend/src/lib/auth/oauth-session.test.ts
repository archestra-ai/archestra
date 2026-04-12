import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOAuthReauthChatResume,
  getOAuthReauthChatResume,
  setOAuthReauthChatResume,
} from "./oauth-session";

describe("oauth-session reauth chat resume", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores a pending chat resume message for chat return URLs", () => {
    setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/chat/conv_123",
      serverName: "PostHog",
    });

    expect(getOAuthReauthChatResume()).toEqual({
      conversationId: "conv_123",
      message:
        'I re-authenticated the "PostHog" connection. Please retry the last failed tool call and continue from where we left off.',
    });
  });

  it("ignores non-chat return URLs", () => {
    setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/mcp/registry",
      serverName: "PostHog",
    });

    expect(getOAuthReauthChatResume()).toBeNull();
  });

  it("clears the pending chat resume message", () => {
    setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/chat/conv_123",
      serverName: "PostHog",
    });

    clearOAuthReauthChatResume();

    expect(getOAuthReauthChatResume()).toBeNull();
  });
});
