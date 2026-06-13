import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import config from "@/config";

const { mockForward, mockGetNgrokConfig, mockSaveNgrokConfig } = vi.hoisted(
  () => ({
    mockForward: vi.fn(),
    mockGetNgrokConfig: vi.fn(),
    mockSaveNgrokConfig: vi.fn(),
  }),
);

vi.mock("@ngrok/ngrok", () => ({ forward: mockForward }));
vi.mock("@/models/chatops-config", () => ({
  default: {
    getNgrokConfig: mockGetNgrokConfig,
    saveNgrokConfig: mockSaveNgrokConfig,
  },
}));

const { ngrokTunnelManager } = await import("./ngrok-tunnel-manager");

const listener = (url: string) => ({
  url: () => url,
  close: vi.fn().mockResolvedValue(undefined),
});

describe("NgrokTunnelManager", () => {
  beforeEach(() => {
    mockForward.mockReset();
    mockGetNgrokConfig.mockReset().mockResolvedValue(null);
    mockSaveNgrokConfig.mockReset().mockResolvedValue(undefined);
    config.ngrok.authToken = "";
    config.ngrok.domain = "";
  });

  afterEach(async () => {
    await ngrokTunnelManager.cleanup();
    config.ngrok.authToken = "";
    config.ngrok.domain = "";
  });

  test("initialize is a no-op when neither DB nor env has a token", async () => {
    await ngrokTunnelManager.initialize();

    expect(mockForward).not.toHaveBeenCalled();
    expect(ngrokTunnelManager.getPublicDomain()).toBe("");
  });

  test("initialize connects from the env token and forwards to the API port", async () => {
    config.ngrok.authToken = "env_token";
    mockForward.mockResolvedValue(listener("https://abc123.ngrok-free.dev"));

    await ngrokTunnelManager.initialize();

    expect(mockForward).toHaveBeenCalledWith({
      addr: config.api.port,
      authtoken: "env_token",
    });
    // Domain is reported without the scheme to match the existing contract.
    expect(ngrokTunnelManager.getPublicDomain()).toBe("abc123.ngrok-free.dev");
  });

  test("initialize prefers the DB config over the env token", async () => {
    config.ngrok.authToken = "env_token";
    mockGetNgrokConfig.mockResolvedValue({
      authToken: "db_token",
      domain: "my-app.ngrok.app",
    });
    mockForward.mockResolvedValue(listener("https://my-app.ngrok.app"));

    await ngrokTunnelManager.initialize();

    expect(mockForward).toHaveBeenCalledWith({
      addr: config.api.port,
      authtoken: "db_token",
      domain: "my-app.ngrok.app",
    });
  });

  test("initialize keeps the reserved domain visible when connect fails", async () => {
    mockGetNgrokConfig.mockResolvedValue({
      authToken: "db_token",
      domain: "my-app.ngrok.app",
    });
    mockForward.mockRejectedValue(new Error("connection refused"));

    await expect(ngrokTunnelManager.initialize()).resolves.toBeUndefined();
    expect(ngrokTunnelManager.getPublicDomain()).toBe("my-app.ngrok.app");
  });

  test("initialize skips a config the user explicitly stopped, even with an env token", async () => {
    config.ngrok.authToken = "env_token";
    mockGetNgrokConfig.mockResolvedValue({
      authToken: "db_token",
      domain: "",
      enabled: false,
    });

    await ngrokTunnelManager.initialize();

    expect(mockForward).not.toHaveBeenCalled();
    expect(ngrokTunnelManager.getPublicDomain()).toBe("");
  });

  test("start connects and persists the credentials", async () => {
    mockForward.mockResolvedValue(listener("https://abc123.ngrok-free.dev"));

    const domain = await ngrokTunnelManager.start({ authToken: "tok_123" });

    expect(domain).toBe("abc123.ngrok-free.dev");
    expect(mockSaveNgrokConfig).toHaveBeenCalledWith({
      authToken: "tok_123",
      domain: "",
      enabled: true,
    });
  });

  test("start throws and does not persist when the tunnel cannot connect", async () => {
    mockForward.mockRejectedValue(new Error("bad token"));

    await expect(
      ngrokTunnelManager.start({ authToken: "bad" }),
    ).rejects.toThrow();
    expect(mockSaveNgrokConfig).not.toHaveBeenCalled();
    expect(ngrokTunnelManager.getPublicDomain()).toBe("");
  });

  test("stop disconnects but keeps the credentials, marked disabled", async () => {
    mockForward.mockResolvedValue(listener("https://abc123.ngrok-free.dev"));
    await ngrokTunnelManager.start({ authToken: "tok_123" });
    mockGetNgrokConfig.mockResolvedValue({
      authToken: "tok_123",
      domain: "my-app.ngrok.app",
      enabled: true,
    });

    await ngrokTunnelManager.stop();

    expect(ngrokTunnelManager.getPublicDomain()).toBe("");
    // Credentials survive the stop so a later reconnect can reuse them.
    expect(mockSaveNgrokConfig).toHaveBeenLastCalledWith({
      authToken: "tok_123",
      domain: "my-app.ngrok.app",
      enabled: false,
    });
  });

  test("cleanup disconnects without clearing the persisted credentials", async () => {
    mockForward.mockResolvedValue(listener("https://abc123.ngrok-free.dev"));
    await ngrokTunnelManager.start({ authToken: "tok_123" });
    mockSaveNgrokConfig.mockClear();

    await ngrokTunnelManager.cleanup();

    expect(ngrokTunnelManager.getPublicDomain()).toBe("");
    expect(mockSaveNgrokConfig).not.toHaveBeenCalled();
  });
});
