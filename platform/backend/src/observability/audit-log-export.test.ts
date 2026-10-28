import { context, TraceFlags, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { vi } from "vitest";
import config from "@/config";
import AuditLogModel from "@/models/audit-log";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const originalEnabled = config.auditLog.otelEnabled;
let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;
let sdk: NodeSDK;
beforeEach(() => {
  sdk = new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [],
    logRecordProcessors: [],
  });
  sdk.start();
  logs.disable();
  exporter = new InMemoryLogRecordExporter();
  provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.setGlobalLoggerProvider(provider);
  config.auditLog.otelEnabled = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  config.auditLog.otelEnabled = originalEnabled;
  await provider.shutdown();
  logs.disable();
  await sdk.shutdown();
  context.disable();
});

const payload = {
  actorType: "system" as const,
  action: "agent.updated" as const,
  outcome: "denied" as const,
  occurredAt: new Date("2026-01-01T00:00:00Z"),
  resourceId: "audit-test-resource",
  httpMethod: "PATCH",
  httpRoute: "/api/agents/:id",
  httpStatus: 403,
  sourceIp: "192.0.2.1",
  actorEmail: "private@example.com",
  actorName: "Private name",
  resourceName: "Sensitive resource",
  httpPath: "/api/agents?token=private",
  userAgent: "private-agent",
  before: { secret: "old-secret" },
  after: { prompt: "private prompt", password: "new-secret" },
};

describe("persisted audit OTLP export", () => {
  test("exports allowlisted metadata with the persisted ID and unsampled trace context", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const spanContext = {
      traceId: "12345678901234567890123456789012",
      spanId: "1234567890123456",
      traceFlags: TraceFlags.NONE,
    };
    const row = await context.with(
      trace.setSpanContext(context.active(), spanContext),
      () => AuditLogModel.create({ ...payload, organizationId: org.id }),
    );
    await provider.forceFlush();
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    expect(records[0].attributes).toMatchObject({
      "log.record.uid": row.id,
      "archestra.organization.id": org.id,
      "archestra.audit.event_sequence": row.eventSequence,
      "archestra.audit.outcome": "denied",
      "archestra.audit.resource_id": "audit-test-resource",
      "http.route": "/api/agents/:id",
      "http.response.status_code": 403,
      "client.address": "192.0.2.1",
    });
    expect(records[0].eventName).toBe("archestra.audit.agent.updated");
    expect(records[0].hrTime[0]).toBe(payload.occurredAt.getTime() / 1000);
    expect(records[0].spanContext).toEqual(spanContext);
    expect(records[0].instrumentationScope.name).toBe("archestra-audit");
    const serialized = JSON.stringify(records[0]);
    for (const secret of [
      "private@example.com",
      "Private name",
      "Sensitive resource",
      "token=private",
      "private-agent",
      "old-secret",
      "private prompt",
      "new-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(row.after).toEqual(payload.after);
  });

  test("disabled export still persists audit rows", async ({
    makeOrganization,
  }) => {
    config.auditLog.otelEnabled = false;
    const org = await makeOrganization();
    const row = await AuditLogModel.create({
      ...payload,
      organizationId: org.id,
    });
    expect(await AuditLogModel.findById(row.id, org.id)).not.toBeNull();
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  test("failed inserts never emit an audit event", async () => {
    await expect(
      AuditLogModel.create({ ...payload, organizationId: "missing-org" }),
    ).rejects.toThrow();
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  });

  test("an exporter failure does not reject a persisted audit event", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    vi.spyOn(logs, "getLogger").mockImplementation(() => {
      throw new Error("export unavailable");
    });
    const row = await AuditLogModel.create({
      ...payload,
      organizationId: org.id,
    });
    expect(await AuditLogModel.findById(row.id, org.id)).not.toBeNull();
  });
});
