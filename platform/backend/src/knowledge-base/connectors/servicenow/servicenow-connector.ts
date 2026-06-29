import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  ServiceNowCheckpoint,
  ServiceNowConfig,
} from "@/types";
import { ServiceNowConfigSchema } from "@/types";
import { stripHtmlTags } from "@/utils/strip-html";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INITIAL_SYNC_MONTHS = 6;

export class ServiceNowConnector extends BaseConnector {
  type = "servicenow" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid ServiceNow configuration: instanceUrl (string) is required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.instanceUrl)) {
      return {
        valid: false,
        error: "instanceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid ServiceNow configuration" };
    }

    this.log.debug({ instanceUrl: parsed.instanceUrl }, "Testing connection");

    try {
      const url = this.joinUrl(
        parsed.instanceUrl,
        "/api/now/table/incident?sysparm_limit=1&sysparm_fields=sys_id",
      );
      const response = await this.fetchWithRetry(url, {
        headers: buildHeaders(params.credentials),
      });

      if (!response.ok) {
        const body = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      this.log.debug("Connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ServiceNowCheckpoint | null) ?? {
        type: "servicenow" as const,
      };
      const headers = buildHeaders(params.credentials);
      const entities = getEnabledEntities(parsed);
      let total = 0;

      for (const entity of entities) {
        const query = buildQuery({
          config: parsed,
          checkpoint,
          useStatesAndGroups: entity.useStatesAndGroups,
        });
        const url = this.joinUrl(
          parsed.instanceUrl,
          `/api/now/table/${entity.table}?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=1&sysparm_fields=sys_id`,
        );

        const response = await this.fetchWithRetry(url, { headers });
        if (!response.ok) continue;

        const totalCount = response.headers.get("X-Total-Count");
        if (totalCount) {
          const count = Number.parseInt(totalCount, 10);
          if (!Number.isNaN(count)) total += count;
        }
      }

      return total > 0 ? total : null;
    } catch (error) {
      this.log.warn(
        { error: extractErrorMessage(error) },
        "Failed to estimate total items",
      );
      return null;
    }
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid ServiceNow configuration");
    }

    const checkpoint = (params.checkpoint as ServiceNowCheckpoint | null) ?? {
      type: "servicenow" as const,
    };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const headers = buildHeaders(params.credentials);
    const entities = getEnabledEntities(parsed);

    this.log.debug(
      {
        instanceUrl: parsed.instanceUrl,
        states: parsed.states,
        entities: entities.map((e) => e.table),
        checkpoint,
      },
      "Starting sync",
    );

    for (let entityIdx = 0; entityIdx < entities.length; entityIdx++) {
      const entity = entities[entityIdx];
      const isLastEntity = entityIdx === entities.length - 1;
      const query = buildQuery({
        config: parsed,
        checkpoint,
        startTime: params.startTime,
        useStatesAndGroups: entity.useStatesAndGroups,
      });

      let offset = entityIdx === 0 ? (checkpoint.lastOffset ?? 0) : 0;
      let pageHasMore = true;
      let batchIndex = 0;

      while (pageHasMore) {
        await this.rateLimit();

        try {
          this.log.debug(
            { table: entity.table, batchIndex, offset },
            "Fetching batch",
          );

          const url = this.joinUrl(
            parsed.instanceUrl,
            `/api/now/table/${entity.table}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${entity.fields}&sysparm_limit=${batchSize}&sysparm_offset=${offset}&sysparm_display_value=all`,
          );

          const response = await this.fetchWithRetry(url, { headers });

          if (!response.ok) {
            const body = await response.text();
            throw new Error(
              `ServiceNow API error: HTTP ${response.status} - ${body.slice(0, 500)}`,
            );
          }

          const data = (await response.json()) as {
            result: ServiceNowRecord[];
          };
          const records = data.result ?? [];
          const documents: ConnectorDocument[] = [];

          for (const record of records) {
            documents.push(
              recordToDocument(record, parsed.instanceUrl, entity.table),
            );
          }

          offset += records.length;
          pageHasMore = records.length >= batchSize;

          const lastRecord = records[records.length - 1];
          const lastUpdatedAt = lastRecord?.sys_updated_on?.value;
          const hasMore = pageHasMore || !isLastEntity;

          this.log.debug(
            {
              table: entity.table,
              batchIndex,
              recordCount: records.length,
              documentCount: documents.length,
              hasMore,
            },
            "Batch fetched",
          );

          batchIndex++;
          yield {
            documents,
            failures: this.flushFailures(),
            checkpoint: buildCheckpoint({
              type: "servicenow",
              itemUpdatedAt: lastUpdatedAt,
              previousLastSyncedAt: checkpoint.lastSyncedAt,
              extra: {
                lastOffset: hasMore ? offset : undefined,
              },
            }),
            hasMore,
          };
        } catch (error) {
          this.log.error(
            {
              table: entity.table,
              batchIndex,
              error: extractErrorMessage(error),
            },
            "Batch fetch failed",
          );
          throw error;
        }
      }
    }
  }
}

// ===== Entity definitions =====

interface EntityDef {
  table: string;
  fields: string;
  useStatesAndGroups: boolean;
}

const INCIDENT_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "caller_id",
  "opened_at",
  "resolved_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "severity",
  "company",
  "business_service",
  "problem_id",
].join(",");

const CHANGE_REQUEST_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "risk",
  "type",
  "close_code",
  "reason",
  "start_date",
  "end_date",
  "requested_by",
].join(",");

const CHANGE_TASK_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "change_request",
  "planned_start_date",
  "planned_end_date",
].join(",");

const PROBLEM_FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "urgency",
  "impact",
  "category",
  "assignment_group",
  "assigned_to",
  "opened_at",
  "closed_at",
  "sys_updated_on",
  "sys_created_on",
  "active",
  "known_error",
  "first_reported_by_task",
  "opened_by",
].join(",");

const BUSINESS_APP_FIELDS = [
  "sys_id",
  "name",
  "short_description",
  "version",
  "vendor",
  "operational_status",
  "install_status",
  "sys_updated_on",
  "sys_created_on",
].join(",");

// ===== Module-level helpers =====

interface ServiceNowDisplayValue {
  display_value: string;
  value: string;
  link?: string;
}

type ServiceNowRecord = Record<string, ServiceNowDisplayValue>;

function parseConfig(config: Record<string, unknown>): ServiceNowConfig | null {
  const result = ServiceNowConfigSchema.safeParse({
    type: "servicenow",
    ...config,
  });
  return result.success ? result.data : null;
}

function getEnabledEntities(config: ServiceNowConfig): EntityDef[] {
  const entities: EntityDef[] = [];

  if (config.includeIncidents !== false) {
    entities.push({
      table: "incident",
      fields: INCIDENT_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeChanges === true) {
    entities.push({
      table: "change_request",
      fields: CHANGE_REQUEST_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeChangeRequests === true) {
    entities.push({
      table: "change_task",
      fields: CHANGE_TASK_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeProblems === true) {
    entities.push({
      table: "problem",
      fields: PROBLEM_FIELDS,
      useStatesAndGroups: true,
    });
  }

  if (config.includeBusinessApps === true) {
    entities.push({
      table: "cmdb_ci_business_app",
      fields: BUSINESS_APP_FIELDS,
      useStatesAndGroups: false,
    });
  }

  return entities;
}

function buildQuery(params: {
  config: ServiceNowConfig;
  checkpoint: ServiceNowCheckpoint;
  startTime?: Date;
  useStatesAndGroups: boolean;
}): string {
  const { config, checkpoint, startTime, useStatesAndGroups } = params;
  const clauses: string[] = [];

  if (useStatesAndGroups) {
    if (config.states && config.states.length > 0) {
      const stateFilter = config.states.map((s) => `state=${s}`).join("^OR");
      clauses.push(stateFilter);
    }

    if (config.assignmentGroups && config.assignmentGroups.length > 0) {
      const groupFilter = config.assignmentGroups
        .map((g) => `assignment_group=${g}`)
        .join("^OR");
      clauses.push(groupFilter);
    }
  }

  let syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
  if (!syncFrom) {
    const months = config.syncDataForLastMonths ?? DEFAULT_INITIAL_SYNC_MONTHS;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    syncFrom = cutoff.toISOString();
  }
  const snDate = formatServiceNowDate(syncFrom);
  clauses.push(`sys_created_on>${snDate}`);

  clauses.push("ORDERBYsys_created_on");

  return clauses.join("^");
}

function formatServiceNowDate(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const minutes = String(d.getUTCMinutes()).padStart(2, "0");
  const seconds = String(d.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function buildHeaders(credentials: ConnectorCredentials): HeadersInit {
  const headers: HeadersInit = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (credentials.email) {
    const encoded = Buffer.from(
      `${credentials.email}:${credentials.apiToken}`,
    ).toString("base64");
    headers.Authorization = `Basic ${encoded}`;
  } else {
    headers.Authorization = `Bearer ${credentials.apiToken}`;
  }

  return headers;
}

function dv(field: ServiceNowDisplayValue | undefined): string {
  return field?.display_value ?? field?.value ?? "";
}

function recordToDocument(
  record: ServiceNowRecord,
  instanceUrl: string,
  table: string,
): ConnectorDocument {
  if (table === "cmdb_ci_business_app") {
    return businessAppToDocument(record, instanceUrl);
  }

  const description = dv(record.description);
  const plainText = stripHtmlTags(description);
  const title = dv(record.short_description) || "Untitled";
  const recordNumber = dv(record.number);
  const sysId = record.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/${table}.do?sys_id=${sysId}`
    : undefined;

  const metadata: Record<string, unknown> = {
    sysId,
    number: recordNumber,
    kind: table,
    state: dv(record.state),
    priority: dv(record.priority),
    urgency: dv(record.urgency),
    impact: dv(record.impact),
    category: dv(record.category),
    assignmentGroup: dv(record.assignment_group),
    assignedTo: dv(record.assigned_to),
    active: record.active?.value === "true",
  };

  if (table === "incident") {
    metadata.caller = dv(record.caller_id);
    const severity = dv(record.severity);
    if (severity) metadata.severity = severity;
    const company = dv(record.company);
    if (company) metadata.company = company;
    const businessService = dv(record.business_service);
    if (businessService) metadata.businessService = businessService;
    const problem = dv(record.problem_id);
    if (problem) metadata.problem = problem;
  }

  if (table === "change_request") {
    metadata.risk = dv(record.risk);
    metadata.changeType = dv(record.type);
    metadata.closeCode = dv(record.close_code);
    metadata.reason = dv(record.reason);
    metadata.startDate = dv(record.start_date);
    metadata.endDate = dv(record.end_date);
    metadata.requestedBy = dv(record.requested_by);
  }

  if (table === "change_task") {
    metadata.changeRequest = dv(record.change_request);
    metadata.plannedStartDate = dv(record.planned_start_date);
    metadata.plannedEndDate = dv(record.planned_end_date);
  }

  if (table === "problem") {
    metadata.knownError = dv(record.known_error);
    metadata.firstReportedByTask = dv(record.first_reported_by_task);
    metadata.openedBy = dv(record.opened_by);
  }

  return {
    id: sysId,
    title,
    content: `# ${title}\n\n${plainText}`,
    sourceUrl,
    metadata,
    updatedAt: record.sys_updated_on?.value
      ? new Date(record.sys_updated_on.value)
      : undefined,
  };
}

function businessAppToDocument(
  record: ServiceNowRecord,
  instanceUrl: string,
): ConnectorDocument {
  const name = dv(record.name) || "Untitled";
  const shortDescription = dv(record.short_description);
  const sysId = record.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/cmdb_ci_business_app.do?sys_id=${sysId}`
    : undefined;

  return {
    id: sysId,
    title: name,
    content: `# ${name}\n\n${shortDescription}`,
    sourceUrl,
    metadata: {
      sysId,
      kind: "cmdb_ci_business_app",
      name,
      version: dv(record.version),
      vendor: dv(record.vendor),
      operationalStatus: dv(record.operational_status),
      installStatus: dv(record.install_status),
    },
    updatedAt: record.sys_updated_on?.value
      ? new Date(record.sys_updated_on.value)
      : undefined,
  };
}
