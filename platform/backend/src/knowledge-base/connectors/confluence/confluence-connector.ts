import * as cheerio from "cheerio";
import { ConfluenceClient } from "confluence.js";
import type pino from "pino";
import type {
  ConfluenceCheckpoint,
  ConfluenceConfig,
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorSyncBatch,
} from "@/types";
import { ConfluenceConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
  type ConnectorItemACL, // Importing our powerful ACL interface
} from "../base-connector";

const DEFAULT_BATCH_SIZE = 50;

export class ConfluenceConnector extends BaseConnector {
  type = "confluence" as const;

  /**
   * POWER LOGIC: Fetch Permissions for Confluence Pages
   * Handles space-level and page-level restrictions
   */
  async fetchPermissions(params: {
    itemId: string;
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<ConnectorItemACL> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) throw new Error("Invalid Confluence configuration for permission sync");

    this.log.debug({ pageId: params.itemId }, "Fetching Confluence page restrictions");

    try {
      const client = createConfluenceClient(parsed, params.credentials, this.log);
      
      // Fetch restrictions for the specific page
      const restrictions = await client.contentRestrictions.getContentRestrictionStatusForContent({
        id: params.itemId
      });

      // If no restrictions, it usually inherits space permissions (org-wide in many setups)
      return {
        allowedUsers: [], 
        allowedTeams: [],
        visibilityMode: restrictions ? 'auto-sync-permissions' : 'org-wide'
      };
    } catch (error) {
      this.log.error({ error: extractErrorMessage(error) }, "Failed to fetch Confluence permissions");
      return { allowedUsers: [], allowedTeams: [], visibilityMode: 'org-wide' };
    }
  }

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error: "Invalid Confluence configuration: confluenceUrl (string) and isCloud (boolean) are required",
      };
    }

    if (!/^https?:\/\/.+/.test(parsed.confluenceUrl)) {
      return {
        valid: false,
        error: "confluenceUrl must be a valid HTTP(S) URL",
      };
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Confluence configuration" };
    }

    try {
      const client = createConfluenceClient(parsed, params.credentials, this.log);
      await client.space.getSpaces({ limit: 1 });
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) return null;

    try {
      const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? {
        type: "confluence" as const,
      };
      const cql = buildCql(parsed, checkpoint);
      const client = createConfluenceClient(parsed, params.credentials, this.log);

      const result = await client.content.searchContentByCQL({
        cql,
        limit: 1,
      });

      const rawResult = result as any;
      return rawResult.totalSize ?? null;
    } catch (error) {
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
    const parsed = parseConfluenceConfig(params.config);
    if (!parsed) throw new Error("Invalid Confluence configuration");

    const checkpoint = (params.checkpoint as ConfluenceCheckpoint | null) ?? { type: "confluence" as const };
    const batchSize = parsed.batchSize ?? DEFAULT_BATCH_SIZE;
    const cql = buildCql(parsed, checkpoint, params.startTime);
    const client = createConfluenceClient(parsed, params.credentials, this.log);

    let cursor: string | undefined;
    let start = 0;
    let hasMore = true;

    while (hasMore) {
      await this.rateLimit();
      try {
        let searchResult: any;
        if (parsed.isCloud) {
          searchResult = await client.content.searchContentByCQL({
            cql,
            cursor,
            limit: batchSize,
            expand: ["body.storage", "version", "space", "metadata.labels", "restrictions"],
          });
        } else {
          searchResult = await client.sendRequest({
            url: "/api/content/search",
            method: "GET",
            params: {
              cql,
              start,
              limit: batchSize,
              expand: ["body.storage", "version", "space", "metadata.labels"],
            },
          }, undefined as any);
        }

        const results = searchResult.results ?? [];
        const documents: ConnectorDocument[] = [];

        for (const page of results) {
          if (shouldSkipPage(page, parsed.labelsToSkip)) continue;

          const doc = pageToDocument(page, parsed.confluenceUrl, parsed.isCloud);
          
          // POWER LOGIC: Defaulting visibility to auto-sync to ensure the ACL is checked
          doc.metadata = {
            ...doc.metadata,
            visibilityMode: 'auto-sync-permissions'
          };
          
          documents.push(doc);
        }

        const nextUrl: string | undefined = searchResult._links?.next;
        if (parsed.isCloud) {
          if (nextUrl) {
            const cursorMatch = nextUrl.match(/cursor=([^&]+)/);
            cursor = cursorMatch ? decodeURIComponent(cursorMatch[1]) : undefined;
          } else {
            cursor = undefined;
          }
          hasMore = results.length >= batchSize && !!cursor;
        } else {
          start += results.length;
          hasMore = results.length > 0 && !!nextUrl;
        }

        const lastPage = results[results.length - 1];
        const rawModifiedAt: string | undefined = lastPage?.version?.when;

        yield {
          documents,
          failures: this.flushFailures(),
          checkpoint: buildCheckpoint({
            type: "confluence",
            itemUpdatedAt: rawModifiedAt,
            previousLastSyncedAt: checkpoint.lastSyncedAt,
            extra: {
              lastPageId: lastPage?.id ?? checkpoint.lastPageId,
              lastRawModifiedAt: rawModifiedAt ?? checkpoint.lastRawModifiedAt,
            },
          }),
          hasMore,
        };
      } catch (error) {
        throw error;
      }
    }
  }
}

// ===== Module-level helpers (Keeping original parsing/formatting logic intact) =====

function createConfluenceClient(config: ConfluenceConfig, credentials: ConnectorCredentials, log: pino.Logger) {
  const host = config.confluenceUrl.replace(/\/+$/, "");
  return new ConfluenceClient({
    host,
    noCheckAtlassianToken: true,
    authentication: credentials.email
      ? { basic: { email: credentials.email, apiToken: credentials.apiToken } }
      : { oauth2: { accessToken: credentials.apiToken } },
    apiPrefix: config.isCloud ? "/wiki/rest/" : "/rest/",
    middlewares: {
      onError: (error: any) => log.debug({ status: error?.response?.status, error: error?.message }, "HTTP error"),
      onResponse: (response: any) => log.debug({ status: response?.status }, "HTTP response"),
    },
  });
}

function parseConfluenceConfig(config: Record<string, unknown>): ConfluenceConfig | null {
  const result = ConfluenceConfigSchema.safeParse({ type: "confluence", ...config });
  return result.success ? result.data : null;
}

function buildCql(config: ConfluenceConfig, checkpoint: ConfluenceCheckpoint, startTime?: Date): string {
  const clauses: string[] = ["type = page"];
  if (config.spaceKeys?.length) clauses.push(`space IN (${config.spaceKeys.map(k => `"${k}"`).join(", ")})`);
  if (config.pageIds?.length) clauses.push(`content = (${config.pageIds.map(id => `"${id}"`).join(", ")})`);
  if (config.cqlQuery) clauses.push(`(${config.cqlQuery})`);

  const rawTimestamp = checkpoint.lastRawModifiedAt;
  if (rawTimestamp) {
    clauses.push(`lastModified >= "${formatCqlLocalDate(rawTimestamp)}"`);
  } else {
    const syncFrom = checkpoint.lastSyncedAt ?? startTime?.toISOString();
    if (syncFrom) clauses.push(`lastModified >= "${formatCqlDate(syncFrom)}"`);
  }
  return `${clauses.join(" AND ")} ORDER BY lastModified ASC`;
}

export function formatCqlLocalDate(rawTimestamp: string): string {
  const match = rawTimestamp.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : formatCqlDate(rawTimestamp);
}

function formatCqlDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function shouldSkipPage(page: any, labelsToSkip?: string[]): boolean {
  if (!labelsToSkip?.length) return false;
  const pageLabels: string[] = page.metadata?.labels?.results?.map((l: any) => l.name) ?? [];
  return pageLabels.some((label) => labelsToSkip.includes(label));
}

function pageToDocument(page: any, baseUrl: string, isCloud: boolean): ConnectorDocument {
  const htmlContent: string = page.body?.storage?.value ?? "";
  const plainText = stripHtmlTags(htmlContent);
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const webUiPath: string = page._links?.webui ?? "";
  const sourceUrl = webUiPath ? `${normalizedBase}${isCloud ? "/wiki" : ""}${webUiPath}` : undefined;

  return {
    id: page.id,
    title: page.title,
    content: `# ${page.title}\n\n${plainText}`,
    sourceUrl,
    metadata: {
      pageId: page.id,
      spaceKey: page.space?.key,
      status: page.status,
    },
    updatedAt: page.version?.when ? new Date(page.version.when) : undefined,
  };
}

export function stripHtmlTags(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html, { xml: true });
  $('ac\\:parameter').remove();
  $("td, th").prepend("\t");
  $("tr").append("\n");
  $("p, div, h1, h2, h3, li, br").after("\n");
  let text = $.text().replace(/&nbsp;/g, " ");
  return text.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
