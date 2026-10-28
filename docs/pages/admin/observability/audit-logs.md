---
title: Audit log export
description: Send administrative audit events to your SIEM through an OpenTelemetry Collector
order: 3
lastUpdated: 2026-10-28
---

Send key changes, permission updates, and other recorded administrative actions to your security monitoring stack. Archestra exports metadata from the same persisted events available through its audit API as OpenTelemetry logs.

## Connect Your Collector

Use a collector that accepts OTLP over HTTP and forwards logs to your destination.

1. Set these environment variables on the backend:
   ```bash
   ARCHESTRA_AUDIT_LOG_OTEL_ENABLED=true
   ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
   ```
   [`ARCHESTRA_AUDIT_LOG_OTEL_ENABLED`](/docs/admin/deployment/configuration#ARCHESTRA_AUDIT_LOG_OTEL_ENABLED) enables audit export. The [OTLP endpoint](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT) is shared with backend logs and traces; audit records go to `/v1/logs`.
2. For authentication, set the [bearer token](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER), or the [username](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME) and [password](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD). Use HTTPS for a remote collector.
3. Enable a logs pipeline in your collector, configure its destination, and restart the backend.

For example, this diagnostic collector configuration prints incoming log records:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: detailed
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [debug]
```

Create a test agent, then search the collector output for instrumentation scope `archestra-audit` and event name `archestra.audit.agent.created`. Its `log.record.uid` matches the event ID returned by [`GET /api/audit-logs`](/docs/reference/api#/Audit%20Log/getAuditLogs). Backend logs also use this endpoint; filter by the audit scope to separate them.

## Route Events to Your SIEM

Your collector connects Archestra's OTLP logs to the destination your security team uses.

- Splunk: use the Collector's [Splunk HEC exporter](https://help.splunk.com/en?resourceId=gdi_opentelemetry_components_splunk-hec-exporter) and select a Platform index and sourcetype.
- Microsoft Sentinel: configure the target workspace, authentication and ingestion rules using [Azure Monitor OTLP ingestion](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion), or transform records for its Logs Ingestion API.
- Elastic Security: configure an ingestion endpoint and [map the event fields to ECS](https://www.elastic.co/docs/solutions/security/get-started/elastic-security-requirements).

Receiving OTLP does not configure security detections. Verify that a test event is searchable in the intended index or table and that your rules read its mapped fields.

## Event Content and Delivery

Audit records identify the action and its outcome; the attribute table below lists the exported fields. All records have INFO severity, including denied and failed actions: write security rules against `archestra.audit.outcome`.

- Snapshots, names, emails, raw request URLs, user agents, prompts and responses are excluded. Actor and resource IDs and IP addresses can still identify people; restrict destination access and retention. Some events, including service-account events, have no actor ID.
- Export runs independently of application log levels and trace sampling. Active trace context may accompany a record; it is optional, and the associated trace may not have been retained. Audit export does not add LLM request or MCP tool-call payloads.
- Delivery uses an in-memory batch and is best-effort. Outages, full queues or abrupt shutdown can lose exports. Enabling export does not replay earlier events or guarantee that every action produced an audit row.

Collector transforms can use these attribute keys:

| Information | Attribute |
| --- | --- |
| Event identity | `log.record.uid`, `archestra.audit.event_sequence` |
| Schema and organization | `archestra.audit.schema_version`, `archestra.organization.id` |
| Action and outcome | `archestra.audit.action`, `archestra.audit.outcome` |
| Actor | `archestra.audit.actor_type`, `archestra.audit.actor_id`, `archestra.audit.impersonated_by` |
| Resource | `archestra.audit.resource_type`, `archestra.audit.resource_id` |
| Request | `archestra.audit.request_id`, `http.request.method`, `http.route`, `http.response.status_code`, `client.address` |

Missing values are omitted. Behind a trusted reverse proxy, configure [`ARCHESTRA_TRUST_PROXY`](/docs/admin/deployment/configuration#ARCHESTRA_TRUST_PROXY) to preserve the client IP.

## Retrieve Events Through the API

Use [`GET /api/audit-logs`](/docs/reference/api#/Audit%20Log/getAuditLogs) to retrieve persisted events, including historical records that have not been removed by [audit retention](/docs/admin/deployment/configuration#ARCHESTRA_AUDIT_LOG_RETENTION_DAYS).

Authenticate with a dedicated [service account](/docs/reference/api#service-accounts) whose role has [`auditLog:read`](/docs/reference/permissions#auditLog:read) and [`auditLog:admin`](/docs/reference/permissions#auditLog:admin) for organization-wide collection. Pass `pagination.nextCursor` as the next request's `cursor` until `pagination.hasNext` is false. Pages are newest first; use `limit=100` for 100 events per page (the default is 20).

A scheduled collector needs persistent checkpoints, overlapping date windows, retries and deduplication by deployment and event ID. API responses can contain more sensitive fields than the OTLP export, including snapshots; apply your own allowlist before forwarding them.
