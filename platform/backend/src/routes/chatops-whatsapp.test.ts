import { vi } from "vitest";
import { createFastifyInstance } from "@/server";
import { beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const {
  handleIncomingMessageMock,
  handleValidationChallengeMock,
  providerMock,
  validateWebhookRequestMock,
} = vi.hoisted(() => {
  const validateWebhookRequestMock = vi.fn();
  const handleValidationChallengeMock = vi.fn();
  const handleIncomingMessageMock = vi.fn();
  const providerMock = {
    handleValidationChallenge: handleValidationChallengeMock,
    validateWebhookRequest: validateWebhookRequestMock,
  };
  return {
    handleIncomingMessageMock,
    handleValidationChallengeMock,
    providerMock,
    validateWebhookRequestMock,
  };
});

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    getWhatsAppProvider: vi.fn(() => providerMock),
    handleIncomingMessage: handleIncomingMessageMock,
  },
}));

vi.mock("@/agents/utils", () => ({
  isRateLimited: vi.fn(() => false),
}));

describe("GET /api/webhooks/chatops/whatsapp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("returns Meta verification challenge when token is valid", async () => {
    handleValidationChallengeMock.mockReturnValue("challenge-token");
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-token",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-token");
    expect(handleValidationChallengeMock).toHaveBeenCalledWith({
      "hub.challenge": "challenge-token",
      "hub.mode": "subscribe",
      "hub.verify_token": "verify-token",
    });

    await app.close();
  });

  test("returns 400 when challenge validation fails", async () => {
    handleValidationChallengeMock.mockReturnValue(null);
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-token",
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe("POST /api/webhooks/chatops/whatsapp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("valid signed webhook delegates to ChatOps manager", async () => {
    validateWebhookRequestMock.mockResolvedValue(true);
    handleIncomingMessageMock.mockResolvedValue(undefined);
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);
    const payload = {
      entry: [{ changes: [{ field: "messages", value: { messages: [] } }] }],
    };
    const rawPayload = JSON.stringify(payload);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=test",
      },
      method: "POST",
      payload: rawPayload,
      url: "/api/webhooks/chatops/whatsapp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(validateWebhookRequestMock).toHaveBeenCalledWith(
      rawPayload,
      expect.objectContaining({
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=test",
      }),
    );
    expect(handleIncomingMessageMock).toHaveBeenCalledWith(
      providerMock,
      payload,
    );

    await app.close();
  });

  test("acknowledges the webhook before ChatOps processing settles", async () => {
    validateWebhookRequestMock.mockResolvedValue(true);
    let resolveHandler: (() => void) | undefined;
    handleIncomingMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);
    const payload = {
      entry: [{ changes: [{ field: "messages", value: { messages: [] } }] }],
    };

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=test",
      },
      method: "POST",
      payload: JSON.stringify(payload),
      url: "/api/webhooks/chatops/whatsapp",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(handleIncomingMessageMock).toHaveBeenCalledWith(
      providerMock,
      payload,
    );

    resolveHandler?.();
    await app.close();
  });

  test("invalid signature returns 400 and does not process message", async () => {
    validateWebhookRequestMock.mockResolvedValue(false);
    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=bad",
      },
      method: "POST",
      payload: JSON.stringify({ entry: [] }),
      url: "/api/webhooks/chatops/whatsapp",
    });

    expect(response.statusCode).toBe(400);
    expect(handleIncomingMessageMock).not.toHaveBeenCalled();

    await app.close();
  });
});
