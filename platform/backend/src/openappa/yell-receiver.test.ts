import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import config from "@/config";
import OpenAppaYellModel from "@/models/openappa-yell";
import { expect, test } from "@/test";
import { captureYellReport } from "./yell-receiver";

const realFetch = globalThis.fetch;

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
  const archive = gzipSync(
    JSON.stringify({ message: yell.message, trajectory: [] }),
  );
  const outbound = vi.fn(
    async () =>
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
  expect(outbound).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (enabled)
    expect(outbound).toHaveBeenCalledWith(
      expect.stringMatching(/^https:/),
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
