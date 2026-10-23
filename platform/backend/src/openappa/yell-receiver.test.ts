import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { HttpResponse, http } from "msw";
import { afterEach, vi } from "vitest";
import config from "@/config";
import { decryptEncryptedChatBytes } from "@/content-encryption/encrypted-chat";
import OpenAppaYellModel from "@/models/openappa-yell";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { captureYellReport, REPORT_ENDPOINT } from "./yell-receiver";

// Bypass the upstream HTTP mock for the real short-lived loopback listener.
const realFetch = globalThis.fetch;
// biome-ignore lint/correctness/useHookAtTopLevel: This helper registers Vitest lifecycle hooks, not React hooks.
const server = useMswServer();

afterEach(() => vi.restoreAllMocks());

test.for(
  [false, true].flatMap((analytics) =>
    [false, true].flatMap((forwarding) =>
      [false, true].map((encrypted) => ({ analytics, forwarding, encrypted })),
    ),
  ),
)("stores reports and forwards only with explicit consent ($analytics, $forwarding, encrypted=$encrypted)", async ({
  analytics,
  forwarding,
  encrypted,
}, { makeOrganization }) => {
  config.analytics.enabled = analytics;
  config.openappa.yellForwardingEnabled = forwarding;
  const organizationId = (await makeOrganization()).id;
  const encryptedChat = encrypted
    ? { conversationId: randomUUID(), dek: randomBytes(32) }
    : undefined;
  const yell = await OpenAppaYellModel.record({
    organizationId,
    callerId: "user:test",
    sessionId: encryptedChat?.conversationId ?? randomUUID(),
    toolCallId: randomUUID(),
    message: "A confusing block",
    withTrajectory: true,
  });
  // The host forwards only the native reporter's signed bytes. It adds no
  // caller identity, database metadata, environment variables, or credentials.
  const archive = gzipSync(
    JSON.stringify({
      schema: "openappa.yell.v1",
      message: yell.message,
      trajectory: { facts: [], runtime_events: [] },
    }),
  );
  const received: { body: Buffer; headers: Record<string, string> }[] = [];
  server.use(
    http.post(REPORT_ENDPOINT, async ({ request }) => {
      received.push({
        body: Buffer.from(await request.arrayBuffer()),
        headers: Object.fromEntries(request.headers),
      });
      return HttpResponse.json({
        receipt_id: "external-receipt",
        duplicate: false,
      });
    }),
  );
  const shouldForward = forwarding && !encrypted;
  await captureYellReport({
    id: yell.id,
    organizationId,
    encryptedChat,
    send: async ({ port, token }) => {
      const result = await realFetch(`http://127.0.0.1:${port}/${token}`, {
        method: "POST",
        headers: {
          "content-encoding": "gzip",
          "x-appa-signature": "v1=test",
          authorization: "Bearer fixture-token-must-stay-local",
          cookie: "fixture-session=must-stay-local",
          "x-private-header": "must-stay-local",
        },
        body: archive,
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        receipt_id: shouldForward ? "external-receipt" : yell.id,
      });
    },
  });
  const stored = await OpenAppaYellModel.findArchive({
    id: yell.id,
    organizationId,
  });
  if (encryptedChat) {
    expect(stored).not.toEqual(archive);
    if (!stored) throw new Error("Missing encrypted report");
    expect(
      decryptEncryptedChatBytes(stored, {
        ...encryptedChat,
        context: "openappa_yells.archive",
      }),
    ).toEqual(archive);
  } else {
    expect(stored).toEqual(archive);
  }
  expect(received).toHaveLength(shouldForward ? 1 : 0);
  if (shouldForward) {
    expect(received[0]?.body).toEqual(archive);
    expect(received[0]?.headers).toEqual(
      expect.objectContaining({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "x-appa-signature": "v1=test",
      }),
    );
    expect(JSON.stringify(received[0])).not.toContain("must-stay-local");
  }
  expect(config.analytics.enabled).toBe(analytics);
});

test.for([
  "unavailable",
  "network",
  "redirect",
  "timeout",
])("keeps the archive after upstream %s and rejects another capture capability", async (failure, {
  makeOrganization,
}) => {
  config.analytics.enabled = false;
  config.openappa.yellForwardingEnabled = true;
  const organizationId = (await makeOrganization()).id;
  const yell = await OpenAppaYellModel.record({
    organizationId,
    callerId: "user:test",
    sessionId: randomUUID(),
    toolCallId: randomUUID(),
    message: "Blocked",
    withTrajectory: false,
  });
  const archive = gzipSync("{}");
  let forwards = 0;
  let redirected = 0;
  if (failure === "timeout") {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      expect(ms).toBe(8000);
      return realTimeout(10);
    });
  }
  server.use(
    http.post(REPORT_ENDPOINT, async () => {
      forwards++;
      if (failure === "network") return HttpResponse.error();
      if (failure === "redirect")
        return HttpResponse.redirect("https://reports.example.com/redirect");
      if (failure === "timeout")
        await new Promise((resolve) => setTimeout(resolve, 50));
      return new HttpResponse("unavailable", { status: 503 });
    }),
    http.post("https://reports.example.com/redirect", () => {
      redirected++;
      return HttpResponse.json({ receipt_id: "unexpected" });
    }),
  );
  await captureYellReport({
    id: yell.id,
    organizationId,
    send: async ({ port, token }) => {
      const wrong = await realFetch(`http://127.0.0.1:${port}/wrong`, {
        method: "POST",
        body: archive,
      });
      expect(wrong.status).toBe(404);
      const result = await realFetch(`http://127.0.0.1:${port}/${token}`, {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: archive,
      });
      expect(result.status).toBe(failure === "unavailable" ? 503 : 500);
    },
  });
  expect(forwards).toBe(1);
  expect(redirected).toBe(0);
  expect(
    await OpenAppaYellModel.findArchive({ id: yell.id, organizationId }),
  ).toEqual(archive);
});
