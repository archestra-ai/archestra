import { existsSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WhatsAppProvider from "./whatsapp-provider";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

function makeProvider(
  overrides: {
    enabled?: boolean;
    phoneEmailMappings?: { phone: string; email: string }[];
  } = {},
): WhatsAppProvider {
  return new WhatsAppProvider({
    enabled: overrides.enabled ?? true,
    phoneEmailMappings: overrides.phoneEmailMappings ?? [],
    sessionDir: "./data/test-whatsapp-session",
  });
}

// =============================================================================
// isConfigured
// =============================================================================

describe("WhatsAppProvider.isConfigured", () => {
  test("returns true when enabled", () => {
    expect(makeProvider({ enabled: true }).isConfigured()).toBe(true);
  });

  test("returns false when disabled", () => {
    expect(makeProvider({ enabled: false }).isConfigured()).toBe(false);
  });
});

// =============================================================================
// getQrCode / getConnectionStatus
// =============================================================================

describe("WhatsAppProvider getters", () => {
  test("initial qr code is null", () => {
    expect(makeProvider().getQrCode()).toBeNull();
  });

  test("initial connection status is disconnected", () => {
    expect(makeProvider().getConnectionStatus()).toBe("disconnected");
  });
});

// =============================================================================
// updatePhoneMappings
// =============================================================================

describe("WhatsAppProvider.updatePhoneMappings", () => {
  test("replaces in-memory mappings", async () => {
    const provider = makeProvider({
      phoneEmailMappings: [{ phone: "111", email: "a@a.com" }],
    });
    provider.updatePhoneMappings([{ phone: "222", email: "b@b.com" }]);
    expect(await provider.getUserEmail("222@s.whatsapp.net")).toBe("b@b.com");
    expect(await provider.getUserEmail("111@s.whatsapp.net")).toBeNull();
  });

  test("empty array clears all mappings", async () => {
    const provider = makeProvider({
      phoneEmailMappings: [{ phone: "111", email: "a@a.com" }],
    });
    provider.updatePhoneMappings([]);
    expect(await provider.getUserEmail("111@s.whatsapp.net")).toBeNull();
  });
});

// =============================================================================
// getUserEmail
// =============================================================================

describe("WhatsAppProvider.getUserEmail", () => {
  test("returns email for a mapped phone number", async () => {
    const provider = makeProvider({
      phoneEmailMappings: [
        { phone: "14155550100", email: "alice@company.com" },
      ],
    });
    expect(await provider.getUserEmail("14155550100@s.whatsapp.net")).toBe(
      "alice@company.com",
    );
  });

  test("returns null for an unmapped number", async () => {
    const provider = makeProvider({
      phoneEmailMappings: [
        { phone: "14155550100", email: "alice@company.com" },
      ],
    });
    expect(
      await provider.getUserEmail("19999999999@s.whatsapp.net"),
    ).toBeNull();
  });

  test("returns null when no mappings configured", async () => {
    const provider = makeProvider({ phoneEmailMappings: [] });
    expect(
      await provider.getUserEmail("14155550100@s.whatsapp.net"),
    ).toBeNull();
  });
});

// =============================================================================
// clearSession
// =============================================================================

describe("WhatsAppProvider.clearSession", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("deletes session directory when it exists", () => {
    const provider = makeProvider();
    provider.clearSession();
    expect(rmSync).toHaveBeenCalledWith("./data/test-whatsapp-session", {
      recursive: true,
      force: true,
    });
  });

  test("does nothing when session directory does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const provider = makeProvider();
    provider.clearSession();
    expect(rmSync).not.toHaveBeenCalled();
  });
});

// =============================================================================
// parseWebhookNotification
// =============================================================================

describe("WhatsAppProvider.parseWebhookNotification", () => {
  test("parses a valid 1-on-1 text message", async () => {
    const provider = makeProvider({
      phoneEmailMappings: [
        { phone: "14155550100", email: "alice@company.com" },
      ],
    });
    const msg = {
      key: {
        remoteJid: "14155550100@s.whatsapp.net",
        id: "msg-1",
        fromMe: false,
      },
      message: { conversation: "Hello agent" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    const result = await provider.parseWebhookNotification(msg);

    expect(result).not.toBeNull();
    expect(result?.text).toBe("Hello agent");
    expect(result?.senderEmail).toBe("alice@company.com");
    expect(result?.channelId).toBe("14155550100@s.whatsapp.net");
  });

  test("returns null for group messages (@g.us)", async () => {
    const provider = makeProvider();
    const msg = {
      key: { remoteJid: "1234567890@g.us", id: "msg-2", fromMe: false },
      message: { conversation: "Group message" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    expect(await provider.parseWebhookNotification(msg)).toBeNull();
  });

  test("returns null for status broadcasts", async () => {
    const provider = makeProvider();
    const msg = {
      key: { remoteJid: "status@broadcast", id: "msg-3", fromMe: false },
      message: { conversation: "Status update" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    expect(await provider.parseWebhookNotification(msg)).toBeNull();
  });

  test("returns null when message has no text content", async () => {
    const provider = makeProvider();
    const msg = {
      key: {
        remoteJid: "14155550100@s.whatsapp.net",
        id: "msg-4",
        fromMe: false,
      },
      message: {},
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    expect(await provider.parseWebhookNotification(msg)).toBeNull();
  });

  test("returns null when message body is missing", async () => {
    const provider = makeProvider();
    const msg = {
      key: {
        remoteJid: "14155550100@s.whatsapp.net",
        id: "msg-5",
        fromMe: false,
      },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    expect(await provider.parseWebhookNotification(msg)).toBeNull();
  });

  test("extracts text from extendedTextMessage", async () => {
    const provider = makeProvider();
    const msg = {
      key: {
        remoteJid: "14155550100@s.whatsapp.net",
        id: "msg-6",
        fromMe: false,
      },
      message: { extendedTextMessage: { text: "Extended text" } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    const result = await provider.parseWebhookNotification(msg);
    expect(result?.text).toBe("Extended text");
  });

  test("senderEmail is undefined for unmapped phone", async () => {
    const provider = makeProvider({ phoneEmailMappings: [] });
    const msg = {
      key: { remoteJid: "99999@s.whatsapp.net", id: "msg-7", fromMe: false },
      message: { conversation: "Hi" },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };

    const result = await provider.parseWebhookNotification(msg);
    expect(result).not.toBeNull();
    expect(result?.senderEmail).toBeUndefined();
  });
});

// =============================================================================
// cleanup
// =============================================================================

describe("WhatsAppProvider.cleanup", () => {
  test("resets status to disconnected and clears qr", async () => {
    const provider = makeProvider();
    await provider.cleanup();
    expect(provider.getConnectionStatus()).toBe("disconnected");
    expect(provider.getQrCode()).toBeNull();
  });
});
