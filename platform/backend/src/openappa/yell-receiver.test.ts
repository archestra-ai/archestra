import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, vi } from "vitest";
import config from "@/config";
import { decryptEncryptedChatBytes } from "@/content-encryption/encrypted-chat";
import OpenAppaYellModel from "@/models/openappa-yell";
import { expect, test } from "@/test";
import { captureYellReport, REPORT_ENDPOINT } from "./yell-receiver";

const realFetch = globalThis.fetch;
const analyticsEnabled = config.analytics.enabled;

test("encrypted-chat reports remain encrypted locally and are never forwarded even with analytics enabled", async ({
  makeOrganization,
}) => {
  config.analytics.enabled = true;
  const organizationId = (await makeOrganization()).id;
  const encryptedChat = { conversationId: randomUUID(), dek: randomBytes(32) };
  const yell = await OpenAppaYellModel.record({
    organizationId,
    callerId: "user:test",
    sessionId: encryptedChat.conversationId,
    toolCallId: randomUUID(),
    message: "Generic report",
    withTrajectory: true,
  });
  const archive = gzipSync(
    JSON.stringify({ message: "private-report-fixture", trajectory: [] }),
  );
  const outbound = vi.fn();
  vi.stubGlobal("fetch", outbound);
  await captureYellReport({
    id: yell.id,
    organizationId,
    encryptedChat,
    send: async ({ port, token }) => {
      const result = await realFetch(`http://127.0.0.1:${port}/${token}`, {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: archive,
      });
      expect(result.status).toBe(200);
    },
  });
  const stored = await OpenAppaYellModel.findArchive({
    id: yell.id,
    organizationId,
  });
  expect(stored).not.toEqual(archive);
  if (!stored) throw new Error("Missing encrypted report");
  expect(
    decryptEncryptedChatBytes(stored, {
      ...encryptedChat,
      context: "openappa_yells.archive",
    }),
  ).toEqual(archive);
  expect(
    outbound.mock.calls.filter(([url]) => url === REPORT_ENDPOINT),
  ).toHaveLength(0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  config.analytics.enabled = analyticsEnabled;
});

test.for([
  false,
  true,
])("retains the exact archive and forwards only when analytics is enabled (%s)", async (enabled, {
  makeOrganization,
}) => {
  config.analytics.enabled = enabled;
  const organizationId = (await makeOrganization()).id;
  const yell = await OpenAppaYellModel.record({
    organizationId,
    callerId: "user:test",
    sessionId: randomUUID(),
    toolCallId: randomUUID(),
    message: "A confusing block",
    withTrajectory: true,
  });
  // The archive carries whatever runtime events the pinned OpenAPPA records,
  // including kinds this host has never seen, and is kept byte for byte.
  const archive = gzipSync(
    JSON.stringify({
      message: yell.message,
      trajectory: [],
      runtime_events: [
        {
          seq: 1,
          at: "2026-10-17T00:00:00Z",
          event: {
            PolicyPublished: {
              deployment: organizationId,
              revision: 2,
              policy_key: "a".repeat(64),
            },
          },
        },
      ],
    }),
  );
  const outbound = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ receipt_id: "external-receipt" }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", outbound);
  await captureYellReport({
    id: yell.id,
    organizationId,
    send: async ({ port, token }) => {
      const result = await realFetch(`http://127.0.0.1:${port}/${token}`, {
        method: "POST",
        headers: { "content-encoding": "gzip", "x-appa-signature": "v1=test" },
        body: archive,
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        receipt_id: enabled ? "external-receipt" : yell.id,
      });
    },
  });
  expect(
    await OpenAppaYellModel.findArchive({ id: yell.id, organizationId }),
  ).toEqual(archive);
  // Other files sharing this non-isolated worker may fetch concurrently; count only report forwards.
  const forwards = outbound.mock.calls.filter(
    ([url]) => url === REPORT_ENDPOINT,
  );
  expect(forwards).toHaveLength(enabled ? 1 : 0);
  if (enabled)
    expect(forwards[0]?.[1]).toEqual(
      expect.objectContaining({
        body: new Uint8Array(archive),
        headers: expect.objectContaining({
          "x-appa-signature": "v1=test",
          "content-encoding": "gzip",
        }),
      }),
    );
});

test("keeps the archive after external failure and rejects another capture capability", async ({
  makeOrganization,
}) => {
  config.analytics.enabled = true;
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unavailable", { status: 503 })),
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
      expect(result.status).toBe(503);
    },
  });
  expect(
    await OpenAppaYellModel.findArchive({ id: yell.id, organizationId }),
  ).toEqual(archive);
});
