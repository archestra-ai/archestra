import type {
  ConnectorCredentials,
  ConnectorDocument,
  ConnectorItemFailure,
  ConnectorSyncBatch,
  SalesforceCheckpoint,
  SalesforceConfig,
} from "@/types";
import { SalesforceConfigSchema } from "@/types";
import {
  BaseConnector,
  buildCheckpoint,
  extractErrorMessage,
} from "../base-connector";

const API_VERSION = "v60.0";
const DEFAULT_BATCH_SIZE = 200;
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const TEST_CONNECTION_SOQL = "SELECT Id FROM User LIMIT 1";

export class SalesforceConnector extends BaseConnector {
  type = "salesforce" as const;

  async validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }> {
    const parsed = parseSalesforceConfig(config);
    if (!parsed) {
      return {
        valid: false,
        error:
          "Invalid Salesforce configuration: loginUrl must be a URL and advancedObjectConfigJson must be valid JSON object text when provided",
      };
    }

    if (parsed.advancedObjectConfigJson) {
      try {
        const obj = JSON.parse(parsed.advancedObjectConfigJson);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
          return {
            valid: false,
            error:
              "Invalid Salesforce configuration: advancedObjectConfigJson must be a JSON object",
          };
        }
      } catch {
        return {
          valid: false,
          error:
            "Invalid Salesforce configuration: advancedObjectConfigJson must be valid JSON object text",
        };
      }
    }

    return { valid: true };
  }

  async testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) {
      return { success: false, error: "Invalid Salesforce configuration" };
    }

    try {
      const session = await loginSalesforce({
        credentials: params.credentials,
        loginUrl: parsed.loginUrl,
      });
      await querySalesforce({
        session,
        soql: TEST_CONNECTION_SOQL,
      });
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Salesforce connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    return null;
  }

  async *sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Salesforce configuration");
    }

    const checkpoint: SalesforceCheckpoint = {
      type: "salesforce",
      ...(params.checkpoint as SalesforceCheckpoint | null),
    };

    const session = await loginSalesforce({
      credentials: params.credentials,
      loginUrl: parsed.loginUrl,
    });
    const advancedConfig = parseAdvancedObjectConfig(
      parsed.advancedObjectConfigJson,
    );
    const objectSpecs = buildObjectSyncSpecs({
      config: parsed,
      advancedConfig,
    });
    const progress = createSyncProgress(checkpoint);
    const failures: ConnectorItemFailure[] = [];

    for (const objectSpec of objectSpecs) {
      const bufferedSyncFrom = resolveObjectSyncLowerBound({
        checkpoint,
        objectName: objectSpec.objectName,
      });
      const soql = buildSoqlQuery({
        objectSpec,
        syncFrom: bufferedSyncFrom,
        batchSize: parsed.batchSize ?? DEFAULT_BATCH_SIZE,
      });

      let queryResponse = await querySalesforce({
        session,
        soql,
      });

      while (true) {
        const documents: ConnectorDocument[] = [];
        for (const record of queryResponse.records) {
          try {
            const doc = salesforceRecordToDocument({
              objectName: objectSpec.objectName,
              record,
              associationFields: objectSpec.associationFields,
            });
            documents.push(doc);
            advanceProgress({
              progress,
              objectName: objectSpec.objectName,
              record,
            });
          } catch (error) {
            failures.push({
              itemId: String(record.Id ?? "unknown"),
              resource: `salesforce.${objectSpec.objectName}`,
              error: extractErrorMessage(error),
            });
          }
        }

        const hasMoreWithinObject = !queryResponse.done;
        const hasRemainingObjects =
          objectSpecs[objectSpecs.length - 1]?.objectName !==
          objectSpec.objectName;
        const nextCheckpoint = buildSalesforceCheckpoint({
          previous: checkpoint,
          progress,
        });
        const batchFailures = [...failures, ...this.flushFailures()];
        failures.length = 0;

        yield {
          documents,
          failures: batchFailures,
          checkpoint: nextCheckpoint,
          hasMore: hasMoreWithinObject || hasRemainingObjects,
        };

        if (!hasMoreWithinObject || !queryResponse.nextRecordsUrl) {
          break;
        }

        queryResponse = await querySalesforceNext({
          session,
          nextRecordsUrl: queryResponse.nextRecordsUrl,
        });
      }
    }
  }
}

// ===== Internal helpers =====

function parseSalesforceConfig(
  config: Record<string, unknown>,
): SalesforceConfig | null {
  const result = SalesforceConfigSchema.safeParse({
    type: "salesforce",
    loginUrl: "https://login.salesforce.com",
    ...config,
  });
  return result.success ? result.data : null;
}

type SalesforceSession = {
  accessToken: string;
  instanceUrl: string;
};

type SalesforceQueryResponse = {
  done: boolean;
  totalSize: number;
  records: SalesforceRecord[];
  nextRecordsUrl?: string;
};

type SalesforceRecord = Record<string, unknown> & {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  attributes?: {
    type?: string;
    url?: string;
  };
};

type AdvancedObjectConfig = Record<
  string,
  {
    fields?: string[];
    associations?: Record<string, string[]>;
  }
>;

type ObjectSyncSpec = {
  objectName: string;
  fields: string[];
  associationFields: string[];
};

type SyncProgress = {
  objectCursorMap: Record<string, string>;
  maxLastSyncedAt?: string;
};

const DEFAULT_OBJECTS = ["Account"];
const DEFAULT_SIMPLE_FIELDS = ["Id", "Name", "LastModifiedDate"];

async function loginSalesforce(params: {
  credentials: ConnectorCredentials;
  loginUrl: string;
}): Promise<SalesforceSession> {
  const username = params.credentials.email?.trim();
  const passwordAndToken = params.credentials.apiToken?.trim();
  if (!username || !passwordAndToken) {
    throw new Error("Missing Salesforce username or password+security token");
  }

  const soapEnvelope = buildSoapLoginEnvelope({
    username,
    passwordAndToken,
  });

  const soapUrl = `${params.loginUrl}/services/Soap/u/${API_VERSION}`;
  const response = await fetch(soapUrl, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=UTF-8",
      SOAPAction: "login",
    },
    body: soapEnvelope,
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Salesforce login failed (${response.status}): ${extractSoapFault(body) ?? "Unknown SOAP fault"}`,
    );
  }

  const accessToken = extractXmlTag(body, "sessionId");
  const serverUrl = extractXmlTag(body, "serverUrl");
  if (!accessToken || !serverUrl) {
    throw new Error("Salesforce login response missing sessionId/serverUrl");
  }

  const instanceUrl = new URL(serverUrl).origin;
  return { accessToken, instanceUrl };
}

async function querySalesforce(params: {
  session: SalesforceSession;
  soql: string;
}): Promise<SalesforceQueryResponse> {
  const queryUrl = `${params.session.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(params.soql)}`;
  return requestSalesforceQuery({
    session: params.session,
    url: queryUrl,
  });
}

async function querySalesforceNext(params: {
  session: SalesforceSession;
  nextRecordsUrl: string;
}): Promise<SalesforceQueryResponse> {
  const queryUrl = `${params.session.instanceUrl}${params.nextRecordsUrl}`;
  return requestSalesforceQuery({
    session: params.session,
    url: queryUrl,
  });
}

async function requestSalesforceQuery(params: {
  session: SalesforceSession;
  url: string;
}): Promise<SalesforceQueryResponse> {
  const response = await fetch(params.url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.session.accessToken}`,
      "Content-Type": "application/json",
    },
  });

  const body = (await response.json()) as unknown;

  if (!response.ok) {
    const message = extractSalesforceApiErrorMessage(body);
    throw new Error(
      `Salesforce query failed (${response.status}): ${message ?? "Unknown error"}`,
    );
  }

  const parsed = body as SalesforceQueryResponse;
  return {
    done: Boolean(parsed.done),
    totalSize: Number(parsed.totalSize ?? 0),
    records: (parsed.records ?? []) as SalesforceRecord[],
    nextRecordsUrl: parsed.nextRecordsUrl,
  };
}

function parseAdvancedObjectConfig(
  advancedObjectConfigJson?: string,
): AdvancedObjectConfig | null {
  if (!advancedObjectConfigJson) return null;
  const parsed = JSON.parse(advancedObjectConfigJson) as AdvancedObjectConfig;
  return parsed;
}

function buildObjectSyncSpecs(params: {
  config: SalesforceConfig;
  advancedConfig: AdvancedObjectConfig | null;
}): ObjectSyncSpec[] {
  if (params.advancedConfig) {
    const entries = Object.entries(params.advancedConfig);
    if (entries.length === 0) return [];
    return entries.map(([objectName, spec]) => {
      const fields = dedupeAndEnsureBaseFields(spec.fields ?? []);
      const associationFields = flattenAssociationFields(
        spec.associations ?? {},
      );
      return { objectName, fields, associationFields };
    });
  }

  const objects =
    params.config.objects && params.config.objects.length > 0
      ? params.config.objects
      : DEFAULT_OBJECTS;
  return objects.map((objectName) => ({
    objectName,
    fields: [...DEFAULT_SIMPLE_FIELDS],
    associationFields: [],
  }));
}

function buildSoqlQuery(params: {
  objectSpec: ObjectSyncSpec;
  syncFrom?: string;
  batchSize: number;
}): string {
  const selected = params.objectSpec.fields.join(", ");
  const whereClause = params.syncFrom
    ? ` WHERE LastModifiedDate >= ${toSalesforceDateLiteral(params.syncFrom)}`
    : "";
  return `SELECT ${selected} FROM ${params.objectSpec.objectName}${whereClause} ORDER BY LastModifiedDate ASC LIMIT ${params.batchSize}`;
}

function salesforceRecordToDocument(params: {
  objectName: string;
  record: SalesforceRecord;
  associationFields: string[];
}): ConnectorDocument {
  const recordId = String(params.record.Id ?? "");
  if (!recordId) {
    throw new Error("Salesforce record missing Id");
  }

  const title = String(
    params.record.Name ?? `${params.objectName} ${recordId.slice(0, 8)}`,
  );
  const flatFields = Object.entries(params.record)
    .filter(([key]) => key !== "attributes")
    .map(([key, value]) => `**${key}:** ${serializeValue(value)}`);
  const content = [`# ${params.objectName}: ${title}`, "", ...flatFields].join(
    "\n",
  );

  const sourcePath = params.record.attributes?.url;
  const sourceUrl = sourcePath
    ? `https://salesforce.com${sourcePath}`
    : undefined;
  const lastModified = params.record.LastModifiedDate;

  return {
    id: `salesforce:${params.objectName}:${recordId}`,
    title,
    content,
    sourceUrl,
    metadata: {
      objectName: params.objectName,
      recordId,
      lastModifiedDate: lastModified,
      associationFields: params.associationFields,
    },
    updatedAt: lastModified ? new Date(lastModified) : undefined,
  };
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dedupeAndEnsureBaseFields(fields: string[]): string[] {
  const normalized = fields.filter((field) => field.trim().length > 0);
  const merged = [...normalized];
  for (const base of DEFAULT_SIMPLE_FIELDS) {
    if (!merged.includes(base)) {
      merged.push(base);
    }
  }
  return [...new Set(merged)];
}

function flattenAssociationFields(
  associations: Record<string, string[]>,
): string[] {
  const fields: string[] = [];
  for (const [associationName, associationFields] of Object.entries(
    associations,
  )) {
    for (const field of associationFields) {
      if (!field.trim()) continue;
      fields.push(`${associationName}.${field}`);
    }
  }
  return fields;
}

function createSyncProgress(checkpoint: SalesforceCheckpoint): SyncProgress {
  const objectCursorMap = { ...(checkpoint.objectCursorMap ?? {}) };
  const maxLastSyncedAt = checkpoint.lastSyncedAt;
  return { objectCursorMap, maxLastSyncedAt };
}

function advanceProgress(params: {
  progress: SyncProgress;
  objectName: string;
  record: SalesforceRecord;
}): void {
  const candidate = params.record.LastModifiedDate;
  if (!candidate) return;

  const previousObjectCursor =
    params.progress.objectCursorMap[params.objectName];
  if (!previousObjectCursor || candidate > previousObjectCursor) {
    params.progress.objectCursorMap[params.objectName] = candidate;
  }
  if (
    !params.progress.maxLastSyncedAt ||
    candidate > params.progress.maxLastSyncedAt
  ) {
    params.progress.maxLastSyncedAt = candidate;
  }
}

function buildSalesforceCheckpoint(params: {
  previous: SalesforceCheckpoint;
  progress: SyncProgress;
}): SalesforceCheckpoint {
  const checkpoint = buildCheckpoint({
    type: "salesforce",
    itemUpdatedAt: params.progress.maxLastSyncedAt,
    previousLastSyncedAt: params.previous.lastSyncedAt,
    extra: {
      objectCursorMap: params.progress.objectCursorMap,
    },
  });
  return checkpoint;
}

function resolveObjectSyncLowerBound(params: {
  checkpoint: SalesforceCheckpoint;
  objectName: string;
}): string | undefined {
  const objectCursor = params.checkpoint.objectCursorMap?.[params.objectName];
  if (objectCursor) {
    return subtractSafetyBuffer(objectCursor);
  }
  if (params.checkpoint.lastSyncedAt) {
    return subtractSafetyBuffer(params.checkpoint.lastSyncedAt);
  }
  return undefined;
}

function subtractSafetyBuffer(isoDate: string): string {
  return new Date(
    new Date(isoDate).getTime() - INCREMENTAL_SAFETY_BUFFER_MS,
  ).toISOString();
}

function toSalesforceDateLiteral(isoDate: string): string {
  return new Date(isoDate).toISOString();
}

function buildSoapLoginEnvelope(params: {
  username: string;
  passwordAndToken: string;
}): string {
  return [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">',
    "  <env:Body>",
    '    <n1:login xmlns:n1="urn:partner.soap.sforce.com">',
    `      <n1:username>${escapeXml(params.username)}</n1:username>`,
    `      <n1:password>${escapeXml(params.passwordAndToken)}</n1:password>`,
    "    </n1:login>",
    "  </env:Body>",
    "</env:Envelope>",
  ].join("\n");
}

function extractSoapFault(body: string): string | null {
  return (
    extractXmlTag(body, "faultstring") ??
    extractXmlTag(body, "exceptionMessage") ??
    null
  );
}

function extractSalesforceApiErrorMessage(body: unknown): string | undefined {
  if (Array.isArray(body)) {
    const first = body[0] as
      | { message?: unknown; errorCode?: unknown }
      | undefined;
    if (typeof first?.message === "string") return first.message;
    if (typeof first?.errorCode === "string") return first.errorCode;
    return undefined;
  }

  if (body && typeof body === "object") {
    const record = body as { message?: unknown; errorCode?: unknown };
    if (typeof record.message === "string") return record.message;
    if (typeof record.errorCode === "string") return record.errorCode;
  }
  return undefined;
}

function extractXmlTag(xml: string, tag: string): string | null {
  const regex = new RegExp(
    `<([a-zA-Z0-9_]+:)?${tag}>([\\s\\S]*?)<\\/([a-zA-Z0-9_]+:)?${tag}>`,
  );
  const match = xml.match(regex);
  return match?.[2]?.trim() ?? null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
