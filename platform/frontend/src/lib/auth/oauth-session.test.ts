import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOAuthPendingChatResume,
  getOAuthPendingChatResume,
  getOAuthUserConfigValues,
  setOAuthInstallChatResume,
  setOAuthReauthChatResume,
  setOAuthUserConfigValues,
} from "./oauth-session";

describe("oauth-session reauth chat resume", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores a pending chat resume message for chat return URLs", () => {
    const conversationId = setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/chat/conv_123",
      serverName: "PostHog",
    });

    expect(conversationId).toBe("conv_123");
    expect(getOAuthPendingChatResume()).toEqual({
      conversationId: "conv_123",
      message:
        'I re-authenticated the "PostHog" connection. Please retry the last failed tool call and continue from where we left off.',
    });
  });

  it("ignores non-chat return URLs", () => {
    const conversationId = setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/mcp/registry",
      serverName: "PostHog",
    });

    expect(conversationId).toBeNull();
    expect(getOAuthPendingChatResume()).toBeNull();
  });

  it("clears the pending chat resume message", () => {
    setOAuthReauthChatResume({
      returnUrl: "http://localhost:3000/chat/conv_123",
      serverName: "PostHog",
    });

    clearOAuthPendingChatResume();

    expect(getOAuthPendingChatResume()).toBeNull();
  });
});

describe("oauth-session install chat resume", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("stores an install-specific resume message and returns the conversation id for chat return URLs", () => {
    const conversationId = setOAuthInstallChatResume({
      returnUrl: "http://localhost:3000/chat/conv_456",
      serverName: "Atlassian",
    });

    expect(conversationId).toBe("conv_456");
    expect(getOAuthPendingChatResume()).toEqual({
      conversationId: "conv_456",
      message:
        'I connected the "Atlassian" integration. Please retry what I asked and continue from where we left off.',
    });
  });

  it("does not store a resume (and returns null) for non-chat return URLs", () => {
    const conversationId = setOAuthInstallChatResume({
      returnUrl: "http://localhost:3000/mcp/registry",
      serverName: "Atlassian",
    });

    expect(conversationId).toBeNull();
    expect(getOAuthPendingChatResume()).toBeNull();
  });
});

describe("oauth-session user config storage", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("persists only non-sensitive user config values for non-BYOS local OAuth", () => {
    setOAuthUserConfigValues({
      values: {
        tenant_id: "tenant-123",
        api_key: "super-secret",
      },
      userConfig: {
        tenant_id: { sensitive: false },
        api_key: { sensitive: true },
      },
      isByosVault: false,
    });

    expect(getOAuthUserConfigValues()).toEqual({
      tenant_id: "tenant-123",
    });
  });

  it("keeps vault references for sensitive user config values in BYOS mode", () => {
    setOAuthUserConfigValues({
      values: {
        api_key: "kv/team/service#api_key",
      },
      userConfig: {
        api_key: { sensitive: true },
      },
      isByosVault: true,
    });

    expect(getOAuthUserConfigValues()).toEqual({
      api_key: "kv/team/service#api_key",
    });
  });

  it("clears stored user config when nothing safe should persist", () => {
    setOAuthUserConfigValues({
      values: {
        api_key: "super-secret",
      },
      userConfig: {
        api_key: { sensitive: true },
      },
      isByosVault: false,
    });

    expect(getOAuthUserConfigValues()).toBeNull();
  });

  it("fails closed when user config metadata is missing", () => {
    setOAuthUserConfigValues({
      values: {
        tenant_id: "tenant-123",
      },
      userConfig: undefined,
      isByosVault: false,
    });

    expect(getOAuthUserConfigValues()).toBeNull();
  });
});
