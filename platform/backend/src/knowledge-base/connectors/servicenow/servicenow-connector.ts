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
const API_PATH = "/api/now/table/kb_knowledge";

/** Fields requested from the ServiceNow Table API. */
const FIELDS = [
  "sys_id",
  "number",
  "short_description",
  "text",
  "kb_knowledge_base",
  "kb_category",
  "workflow_state",
  "sys_updated_on",
  "sys_created_on",
  "author",
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
        knowledgeBases: parsed.knowledgeBases,
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
          result: ServiceNowArticle[];
        };
        const articles = data.result ?? [];
        const documents: ConnectorDocument[] = [];

        for (const article of articles) {
          documents.push(articleToDocument(article, parsed.instanceUrl));
        }

        offset += articles.length;
        hasMore = articles.length >= batchSize;

        const lastArticle = articles[articles.length - 1];
        const lastUpdatedAt = lastArticle?.sys_updated_on?.value;

        this.log.debug(
          {
            batchIndex,
            articleCount: articles.length,
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

interface ServiceNowArticle {
  sys_id: ServiceNowDisplayValue;
  number: ServiceNowDisplayValue;
  short_description: ServiceNowDisplayValue;
  text: ServiceNowDisplayValue;
  kb_knowledge_base: ServiceNowDisplayValue;
  kb_category: ServiceNowDisplayValue;
  workflow_state: ServiceNowDisplayValue;
  sys_updated_on: ServiceNowDisplayValue;
  sys_created_on: ServiceNowDisplayValue;
  author: ServiceNowDisplayValue;
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

  if (!config.includeRetired) {
    clauses.push("workflow_state=published");
  }

  clauses.push("active=true");

  if (config.knowledgeBases && config.knowledgeBases.length > 0) {
    const kbFilter = config.knowledgeBases
      .map((kb) => `kb_knowledge_base=${kb}`)
      .join("^OR");
    clauses.push(kbFilter);
  }

  if (config.categories && config.categories.length > 0) {
    const catFilter = config.categories
      .map((cat) => `kb_category=${cat}`)
      .join("^OR");
    clauses.push(catFilter);
  }

  if (config.query) {
    clauses.push(config.query);
  }

  const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
  if (syncFrom) {
    const snDate = formatServiceNowDate(syncFrom);
    clauses.push(`sys_updated_on>${snDate}`);
  }

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

function articleToDocument(
  article: ServiceNowArticle,
  instanceUrl: string,
): ConnectorDocument {
  const htmlContent = article.text?.display_value ?? article.text?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);
  const title =
    article.short_description?.display_value ??
    article.short_description?.value ??
    "Untitled";
  const articleNumber =
    article.number?.display_value ?? article.number?.value ?? "";
  const sysId = article.sys_id?.value ?? "";

  const normalizedBase = instanceUrl.replace(/\/+$/, "");
  const sourceUrl = sysId
    ? `${normalizedBase}/kb_view.do?sysparm_article=${articleNumber}`
    : undefined;

  return {
    id: sysId,
    title,
    content: `# ${title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      sysId,
      number: articleNumber,
      knowledgeBase:
        article.kb_knowledge_base?.display_value ??
        article.kb_knowledge_base?.value,
      category:
        article.kb_category?.display_value ?? article.kb_category?.value,
      workflowState:
        article.workflow_state?.display_value ?? article.workflow_state?.value,
      author: article.author?.display_value ?? article.author?.value,
      active: article.active?.value === "true",
    },
    updatedAt: article.sys_updated_on?.value
      ? new Date(article.sys_updated_on.value)
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
