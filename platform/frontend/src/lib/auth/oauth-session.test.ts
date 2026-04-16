import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOAuthReauthChatResume,
  getOAuthReauthChatResume,
  getOAuthUserConfigValues,
  setOAuthReauthChatResume,
  setOAuthUserConfigValues,
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
