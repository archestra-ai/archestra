import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
  ServiceNowCheckpoint,
  ServiceNowConfig,
} from "@/types/knowledge-connector";
import { ServiceNowConfigSchema } from "@/types/knowledge-connector";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INITIAL_SYNC_MONTHS = 6;
const API_PATH = "/api/now/table/incident";

/** Fields requested from the ServiceNow Table API. */
const FIELDS = [
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
].join(",");

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
        `${API_PATH}?sysparm_limit=1&sysparm_fields=sys_id`,
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

      const query = buildQuery(parsed, checkpoint);
      const url = this.joinUrl(
        parsed.instanceUrl,
        `${API_PATH}?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=1&sysparm_fields=sys_id`,
      );

      const response = await this.fetchWithRetry(url, {
        headers: buildHeaders(params.credentials),
      });

      if (!response.ok) return null;

      const totalCount = response.headers.get("X-Total-Count");
      if (totalCount) {
        const count = Number.parseInt(totalCount, 10);
        return Number.isNaN(count) ? null : count;
      }

      return null;
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
    const query = buildQuery(parsed, checkpoint, params.startTime);
    const headers = buildHeaders(params.credentials);

    this.log.debug(
      {
        instanceUrl: parsed.instanceUrl,
        states: parsed.states,
        query,
        checkpoint,
      },
      "Starting sync",
    );

    let offset = checkpoint.lastOffset ?? 0;
    let hasMore = true;
    let batchIndex = 0;

    while (hasMore) {
      await this.rateLimit();

      try {
        this.log.debug({ batchIndex, offset }, "Fetching batch");

        const url = this.joinUrl(
          parsed.instanceUrl,
          `${API_PATH}?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=${FIELDS}&sysparm_limit=${batchSize}&sysparm_offset=${offset}&sysparm_display_value=all`,
        );

        const response = await this.fetchWithRetry(url, { headers });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `ServiceNow API error: HTTP ${response.status} - ${body.slice(0, 500)}`,
          );
        }

        const data = (await response.json()) as {
          result: ServiceNowIncident[];
        };
        const incidents = data.result ?? [];
        const documents: ConnectorDocument[] = [];

        for (const incident of incidents) {
          documents.push(incidentToDocument(incident, parsed.instanceUrl));
        }

        offset += incidents.length;
        hasMore = incidents.length >= batchSize;

        const lastIncident = incidents[incidents.length - 1];
        const lastUpdatedAt = lastIncident?.sys_updated_on?.value;

        this.log.debug(
          {
            batchIndex,
            incidentCount: incidents.length,
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
          { batchIndex, error: extractErrorMessage(error) },
          "Batch fetch failed",
        );
        throw error;
      }
    }
  }
}

// ===== Module-level helpers =====

interface ServiceNowDisplayValue {
  display_value: string;
  value: string;
  link?: string;
}

interface ServiceNowIncident {
  sys_id: ServiceNowDisplayValue;
  number: ServiceNowDisplayValue;
  short_description: ServiceNowDisplayValue;
  description: ServiceNowDisplayValue;
  state: ServiceNowDisplayValue;
  priority: ServiceNowDisplayValue;
  urgency: ServiceNowDisplayValue;
  impact: ServiceNowDisplayValue;
  category: ServiceNowDisplayValue;
  assignment_group: ServiceNowDisplayValue;
  assigned_to: ServiceNowDisplayValue;
  caller_id: ServiceNowDisplayValue;
  opened_at: ServiceNowDisplayValue;
  resolved_at: ServiceNowDisplayValue;
  closed_at: ServiceNowDisplayValue;
  sys_updated_on: ServiceNowDisplayValue;
  sys_created_on: ServiceNowDisplayValue;
  active: ServiceNowDisplayValue;
}

function parseConfig(config: Record<string, unknown>): ServiceNowConfig | null {
  const result = ServiceNowConfigSchema.safeParse({
    type: "servicenow",
    ...config,
  });
  return result.success ? result.data : null;
}

function buildQuery(
  config: ServiceNowConfig,
  checkpoint: ServiceNowCheckpoint,
  startTime?: Date,
): string {
  const clauses: string[] = [];

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

  if (config.query) {
    clauses.push(config.query);
  }

  let syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
  if (!syncFrom) {
    const months = config.initialSyncMonths ?? DEFAULT_INITIAL_SYNC_MONTHS;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    syncFrom = cutoff.toISOString();
  }
  const snDate = formatServiceNowDate(syncFrom);
  clauses.push(`sys_updated_on>${snDate}`);

  clauses.push("ORDERBYsys_updated_on");

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

function incidentToDocument(
  incident: ServiceNowIncident,
  instanceUrl: string,
): ConnectorDocument {
  const description =
    incident.description?.display_value ?? incident.description?.value ?? "";
  const plainText = stripHtmlTags(description);
  const title =
    incident.short_description?.display_value ??
    incident.short_description?.value ??
    "Untitled";
  const incidentNumber =
    incident.number?.display_value ?? incident.number?.value ?? "";
  const sysId = incident.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/incident.do?sys_id=${sysId}`
    : undefined;

  return {
    id: sysId,
    title,
    content: `# ${title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      sysId,
      number: incidentNumber,
      state: incident.state?.display_value ?? incident.state?.value,
      priority: incident.priority?.display_value ?? incident.priority?.value,
      urgency: incident.urgency?.display_value ?? incident.urgency?.value,
      impact: incident.impact?.display_value ?? incident.impact?.value,
      category: incident.category?.display_value ?? incident.category?.value,
      assignmentGroup:
        incident.assignment_group?.display_value ??
        incident.assignment_group?.value,
      assignedTo:
        incident.assigned_to?.display_value ?? incident.assigned_to?.value,
      caller: incident.caller_id?.display_value ?? incident.caller_id?.value,
      active: incident.active?.value === "true",
    },
    updatedAt: incident.sys_updated_on?.value
      ? new Date(incident.sys_updated_on.value)
      : undefined,
  };
}

/** Strip HTML tags to produce plain text. */
export function stripHtmlTags(html: string): string {
  let text = html;
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  let prev: string;
  do {
    prev = text;
    text = text.replace(/<[^>]+>/g, "");
  } while (text !== prev);
  text = text.replace(
    /&(amp|lt|gt|quot|#39|nbsp);/g,
    (_match, entity: string) => HTML_ENTITY_MAP[entity] ?? _match,
  );
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};
