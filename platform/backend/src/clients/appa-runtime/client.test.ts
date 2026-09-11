import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { useMswServer } from "@/test/msw";
import { AppaRuntimeClient } from "./client";

const RUNTIME_URL = "http://appa-runtime.test";
// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper, not React.
const server = useMswServer();

test("preserves caller-owned envelope bytes across a durable retry", async () => {
  const bodies: string[] = [];
  let attempts = 0;
  server.use(
    http.post(`${RUNTIME_URL}/proxy/v1/events`, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer transport-token",
      );
      const raw = await request.text();
      bodies.push(raw);
      attempts++;
      if (attempts === 1) return HttpResponse.error();
      const envelope = JSON.parse(raw) as { event_id: string };
      return HttpResponse.json({
        protocol_version: 1,
        event_id: envelope.event_id,
        request_sha256: createHash("sha256").update(raw).digest("hex"),
        decision: { decision: "ack" },
      });
    }),
  );
  const client = clientForTest();
  const prepared = client.prepareEvent({
    eventId: "123e4567-e89b-42d3-a456-426614174001",
    event: { event: "session_start", root_id: "root-1" },
  });

  await expect(client.postPreparedEvent(prepared)).rejects.toMatchObject({
    code: "refused",
  });
  await expect(client.postPreparedEvent(prepared)).resolves.toMatchObject({
    event_id: prepared.eventId,
  });

  expect(bodies).toEqual([prepared.body, prepared.body]);
});

test("does not mask an uncertain receipt outcome as a retryable refusal", async () => {
  server.use(
    http.post(`${RUNTIME_URL}/proxy/v1/events`, () =>
      HttpResponse.json(
        { error: { code: "event_uncertain", message: "pending" } },
        { status: 503 },
      ),
    ),
  );
  const client = clientForTest();
  const prepared = client.prepareEvent({
    eventId: "123e4567-e89b-42d3-a456-426614174002",
    event: { event: "session_start", root_id: "root-1" },
  });

  await expect(client.postPreparedEvent(prepared)).rejects.toMatchObject({
    code: "uncertain",
    runtimeCode: "event_uncertain",
  });
});

test("rejects receipts whose byte digest differs from the persisted request", async () => {
  server.use(
    http.post(`${RUNTIME_URL}/proxy/v1/events`, async ({ request }) => {
      const envelope = (await request.json()) as { event_id: string };
      return HttpResponse.json({
        protocol_version: 1,
        event_id: envelope.event_id,
        request_sha256: "0".repeat(64),
        decision: { decision: "ack" },
      });
    }),
  );
  const client = clientForTest();
  const prepared = client.prepareEvent({
    eventId: "123e4567-e89b-42d3-a456-426614174003",
    event: { event: "session_start", root_id: "root-1" },
  });

  await expect(client.postPreparedEvent(prepared)).rejects.toMatchObject({
    code: "invalid-response",
  });
});

function clientForTest() {
  return new AppaRuntimeClient({
    url: RUNTIME_URL,
    runtimeToken: "transport-token",
  });
}
