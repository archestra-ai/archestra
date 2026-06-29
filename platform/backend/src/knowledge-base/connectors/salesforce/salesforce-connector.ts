import { Connection } from "jsforce";
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

const DEFAULT_BATCH_SIZE = 200;
const INCREMENTAL_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const TEST_CONNECTION_SOQL = "SELECT Id FROM User LIMIT 1";

/**
 * Maximum text length per document (500KB), matching GDrive connector.
 * Prevents oversized documents from very large Description fields or
 * many CaseComments.
 */
const MAX_CONTENT_LENGTH = 500_000;

/**
 * Maximum number of CaseComments to embed per Case document.
 * Beyond this limit we log a truncation warning (matching Linear's
 * comment truncation pattern).
 */
const MAX_CASE_COMMENTS = 100;

/**
 * Default Salesforce objects synced when no explicit objects are configured.
 * Matches the issue scope: Accounts, Contacts, Opportunities, Cases.
 * CaseComments are fetched inline via SOQL subquery on Case.
 */
const DEFAULT_OBJECTS = ["Account", "Contact", "Opportunity", "Case"];
const BASE_FIELDS = ["Id", "LastModifiedDate"];

/**
 * Per-object default fields for richer simple-mode documents.
 * These are standard fields available in every Salesforce org.
 * Custom objects fall back to BASE_FIELDS.
 */
const DEFAULT_FIELDS_BY_OBJECT: Record<string, string[]> = {
  Account: [
    "Id",
    "Name",
    "Industry",
    "Type",
    "Website",
    "Phone",
    "BillingCity",
    "BillingState",
    "OwnerId",
    "LastModifiedDate",
  ],
  Contact: [
    "Id",
    "Name",
    "FirstName",
    "LastName",
    "Email",
    "Phone",
    "Title",
    "AccountId",
    "LastModifiedDate",
  ],
  Opportunity: [
    "Id",
    "Name",
    "Amount",
    "StageName",
    "CloseDate",
    "Probability",
    "AccountId",
    "OwnerId",
    "LastModifiedDate",
  ],
  Case: [
    "Id",
    "CaseNumber",
    "Subject",
    "Status",
    "Priority",
    "Description",
    "ContactId",
    "AccountId",
    "OwnerId",
    "LastModifiedDate",
  ],
  // Knowledge Articles — opt-in via objects list: "Knowledge__kav"
  Knowledge__kav: [
    "Id",
    "Title",
    "Summary",
    "ArticleNumber",
    "PublishStatus",
    "VersionNumber",
    "LastModifiedDate",
  ],
};

/** SOQL relationship subquery to fetch Case Comments inline. */
const CASE_COMMENTS_SUBQUERY =
  "(SELECT Id, CommentBody, CreatedDate FROM CaseComments ORDER BY CreatedDate ASC LIMIT " +
  MAX_CASE_COMMENTS +
  ")";

/**
 * Safe pattern for SOQL identifiers (object names and field names).
 * Allows standard API names, custom fields (__c), relationship paths (Account.Name).
 */
const SAFE_SOQL_IDENTIFIER =
  /^[a-zA-Z_][a-zA-Z0-9_]*(?:__[a-zA-Z0-9]+)?(?:\.[a-zA-Z_][a-zA-Z0-9_]*(?:__[a-zA-Z0-9]+)?)*$/;

// ===== Internal types =====

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
  includeCaseComments: boolean;
};

type SyncProgress = {
  objectCursorMap: Record<string, string>;
  maxLastSyncedAt?: string;
};

type SfQueryResult = {
  done: boolean;
  totalSize: number;
  records: SfRecord[];
  nextRecordsUrl?: string;
};

type SfRecord = Record<string, unknown> & {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  CaseNumber?: string;
  Subject?: string;
  attributes?: { type?: string; url?: string };
  CaseComments?: {
    totalSize: number;
    done: boolean;
    records: Array<{
      CommentBody?: string;
      CreatedDate?: string;
    }>;
  };
};

// ===== Connector =====

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

    // Validate loginUrl is a proper HTTP(S) URL (matching Linear's URL check)
    if (!/^https?:\/\/.+/.test(parsed.loginUrl)) {
      return {
        valid: false,
        error: "loginUrl must be a valid HTTP(S) URL",
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
        // Validate all object names and field names are safe identifiers
        const identifierError = validateAdvancedConfigIdentifiers(obj);
        if (identifierError) {
          return { valid: false, error: identifierError };
        }
      } catch {
        return {
          valid: false,
          error:
            "Invalid Salesforce configuration: advancedObjectConfigJson must be valid JSON object text",
        };
      }
    }

    // Validate object names when specified
    if (parsed.objects && parsed.objects.length > 0) {
      for (const objectName of parsed.objects) {
        if (!SAFE_SOQL_IDENTIFIER.test(objectName)) {
          return {
            valid: false,
            error: `Invalid object name "${objectName}": must be a valid Salesforce API name`,
          };
        }
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
      const conn = await this.createConnection({
        credentials: params.credentials,
        loginUrl: parsed.loginUrl,
      });

      await conn.query(TEST_CONNECTION_SOQL);
      this.log.debug("Salesforce connection test successful");
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error({ error: message }, "Salesforce connection test failed");
      return { success: false, error: `Connection failed: ${message}` };
    }
  }

  async estimateTotalItems(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) return null;

    try {
      const conn = await this.createConnection({
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

      let total = 0;
      for (const spec of objectSpecs) {
        await this.rateLimit();
        try {
          const countResult = (await conn.query(
            `SELECT COUNT() FROM ${spec.objectName}`,
          )) as { totalSize: number };
          total += countResult.totalSize;
        } catch {
          // If COUNT fails for one object (e.g. permissions), skip it
          this.log.debug(
            { objectName: spec.objectName },
            "Salesforce: COUNT query failed, skipping estimate for this object",
          );
        }
      }

      return total > 0 ? total : null;
    } catch {
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
    const parsed = parseSalesforceConfig(params.config);
    if (!parsed) {
      throw new Error("Invalid Salesforce configuration");
    }

    const checkpoint: SalesforceCheckpoint = {
      type: "salesforce",
      ...(params.checkpoint as SalesforceCheckpoint | null),
    };

    const conn = await this.createConnection({
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

    this.log.debug(
      {
        objectCount: objectSpecs.length,
        objects: objectSpecs.map((s) => s.objectName),
        instanceUrl: conn.instanceUrl,
      },
      "Starting Salesforce sync",
    );

    for (const objectSpec of objectSpecs) {
      // Per-object error resilience: if one object fails entirely (e.g.
      // insufficient permissions), log the error and continue to the next
      // object rather than aborting the entire sync run. This matches the
      // resilience pattern used by GDrive (safeItemFetch) and the QA matrix
      // requirement "partial object query failures do not abort the sync."
      yield* this.syncObject({
        conn,
        objectSpec,
        checkpoint,
        progress,
        batchSize: DEFAULT_BATCH_SIZE,
        objectSpecs,
      });
    }
  }

  /**
   * Sync a single Salesforce object, yielding paginated batches.
   *
   * If the initial query for this object fails entirely (e.g. object does
   * not exist, insufficient permissions), we yield a single batch with the
   * failure recorded and move on to the next object — matching the resilience
   * pattern from the QA matrix.
   */
  private async *syncObject(params: {
    conn: Connection;
    objectSpec: ObjectSyncSpec;
    checkpoint: SalesforceCheckpoint;
    progress: SyncProgress;
    batchSize: number;
    objectSpecs: ObjectSyncSpec[];
  }): AsyncGenerator<ConnectorSyncBatch> {
    const { conn, objectSpec, checkpoint, progress, batchSize, objectSpecs } =
      params;

    const bufferedSyncFrom = resolveObjectSyncLowerBound({
      checkpoint,
      objectName: objectSpec.objectName,
    });
    const soql = buildSoqlQuery({
      objectSpec,
      syncFrom: bufferedSyncFrom,
      batchSize,
    });

    this.log.debug(
      { objectName: objectSpec.objectName, soql },
      "Querying Salesforce object",
    );

    await this.rateLimit();
    let queryResult: SfQueryResult;
    try {
      queryResult = (await conn.query(soql)) as SfQueryResult;
    } catch (error) {
      // Per-object resilience: record the failure and continue
      const message = extractErrorMessage(error);
      this.log.warn(
        { objectName: objectSpec.objectName, error: message },
        "Salesforce object query failed, skipping object",
      );

      const hasRemainingObjects =
        objectSpecs[objectSpecs.length - 1]?.objectName !==
        objectSpec.objectName;
      yield {
        documents: [],
        failures: [
          {
            itemId: objectSpec.objectName,
            resource: `salesforce.${objectSpec.objectName}`,
            error: `Query failed: ${message}`,
          },
        ],
        checkpoint: buildSalesforceCheckpoint({
          previous: checkpoint,
          progress,
        }),
        hasMore: hasRemainingObjects,
      };
      return;
    }

    const failures: ConnectorItemFailure[] = [];
    let batchIndex = 0;

    while (true) {
      const documents: ConnectorDocument[] = [];
      for (const record of queryResult.records) {
        try {
          const doc = salesforceRecordToDocument({
            objectName: objectSpec.objectName,
            record,
            instanceUrl: conn.instanceUrl,
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

      // Warn about CaseComment truncation (like Linear warns about >50 comments)
      if (objectSpec.includeCaseComments) {
        for (const record of queryResult.records) {
          const comments = record.CaseComments;
          if (comments && !comments.done) {
            this.log.warn(
              {
                caseId: record.Id,
                totalComments: comments.totalSize,
                fetchedComments: comments.records.length,
              },
              "Case has more comments than the subquery limit; truncating",
            );
          }
        }
      }

      const hasMoreWithinObject =
        !queryResult.done && !!queryResult.nextRecordsUrl;
      const hasRemainingObjects =
        objectSpecs[objectSpecs.length - 1]?.objectName !==
        objectSpec.objectName;
      const nextCheckpoint = buildSalesforceCheckpoint({
        previous: checkpoint,
        progress,
      });
      const batchFailures = [...failures, ...this.flushFailures()];
      failures.length = 0;

      batchIndex++;
      this.log.debug(
        {
          objectName: objectSpec.objectName,
          batchIndex,
          documentCount: documents.length,
          failureCount: batchFailures.length,
          totalSize: queryResult.totalSize,
          hasMoreWithinObject,
          hasRemainingObjects,
        },
        "Salesforce batch complete",
      );

      yield {
        documents,
        failures: batchFailures,
        checkpoint: nextCheckpoint,
        hasMore: hasMoreWithinObject || hasRemainingObjects,
      };

      if (!hasMoreWithinObject) {
        break;
      }

      // Guard: nextRecordsUrl is guaranteed non-null when hasMoreWithinObject
      // is true, but we check explicitly to avoid the non-null assertion lint.
      const nextUrl = queryResult.nextRecordsUrl;
      if (!nextUrl) break;

      await this.rateLimit();
      try {
        queryResult = (await conn.queryMore(nextUrl)) as SfQueryResult;
      } catch (error) {
        throw new Error(
          `Salesforce pagination failed for ${objectSpec.objectName}: ${extractErrorMessage(error)}`,
        );
      }
    }
  }

  /** Create an authenticated jsforce Connection. */
  private async createConnection(params: {
    credentials: ConnectorCredentials;
    loginUrl: string;
  }): Promise<Connection> {
    const username = params.credentials.email?.trim();
    const passwordAndToken = params.credentials.apiToken?.trim();
    if (!username || !passwordAndToken) {
      throw new Error("Missing Salesforce username or password+security token");
    }

    const conn = new Connection({ loginUrl: params.loginUrl });
    await conn.login(username, passwordAndToken);
    this.log.debug(
      { instanceUrl: conn.instanceUrl },
      "Salesforce login successful",
    );
    return conn;
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

  if (!result.success) return null;

  // Normalize object names to avoid accidental invalid identifiers due to whitespace.
  const objects = result.data.objects
    ?.map((o) => o.trim())
    .filter((o) => o.length > 0);

  // Default to core CRM objects when none are specified.
  return {
    ...result.data,
    objects: objects && objects.length > 0 ? objects : DEFAULT_OBJECTS,
  };
}

function parseAdvancedObjectConfig(
  advancedObjectConfigJson?: string,
): AdvancedObjectConfig | null {
  if (!advancedObjectConfigJson) return null;
  try {
    const parsed = JSON.parse(advancedObjectConfigJson) as AdvancedObjectConfig;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Validate that all object names and field names in an advanced config
 * are safe SOQL identifiers to prevent injection.
 */
function validateAdvancedConfigIdentifiers(
  config: Record<string, unknown>,
): string | null {
  for (const objectName of Object.keys(config)) {
    if (!SAFE_SOQL_IDENTIFIER.test(objectName)) {
      return `Invalid object name "${objectName}" in advanced config: must be a valid Salesforce API name`;
    }
    const spec = config[objectName] as {
      fields?: string[];
      associations?: Record<string, string[]>;
    };
    if (spec.fields) {
      for (const field of spec.fields) {
        if (!SAFE_SOQL_IDENTIFIER.test(field)) {
          return `Invalid field name "${field}" on ${objectName}: must be a valid Salesforce API name`;
        }
      }
    }
    if (spec.associations) {
      for (const [assocName, assocFields] of Object.entries(
        spec.associations,
      )) {
        if (!SAFE_SOQL_IDENTIFIER.test(assocName)) {
          return `Invalid association name "${assocName}" on ${objectName}: must be a valid Salesforce API name`;
        }
        for (const field of assocFields) {
          if (!SAFE_SOQL_IDENTIFIER.test(field)) {
            return `Invalid field "${field}" in association ${assocName}: must be a valid Salesforce API name`;
          }
        }
      }
    }
  }
  return null;
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
      return {
        objectName,
        fields,
        associationFields,
        includeCaseComments: objectName === "Case",
      };
    });
  }

  const objects =
    params.config.objects && params.config.objects.length > 0
      ? params.config.objects
      : DEFAULT_OBJECTS;

  return objects.map((objectName) => ({
    objectName,
    fields: DEFAULT_FIELDS_BY_OBJECT[objectName] ?? [...BASE_FIELDS],
    associationFields: [],
    includeCaseComments: objectName === "Case",
  }));
}

function buildSoqlQuery(params: {
  objectSpec: ObjectSyncSpec;
  syncFrom?: string;
  batchSize: number;
}): string {
  const fieldList = [...params.objectSpec.fields];

  // Add association/relationship fields (e.g. Account.Name)
  for (const assocField of params.objectSpec.associationFields) {
    if (!fieldList.includes(assocField)) {
      fieldList.push(assocField);
    }
  }

  // Append Case Comments relationship subquery for Case objects
  if (params.objectSpec.includeCaseComments) {
    fieldList.push(CASE_COMMENTS_SUBQUERY);
  }

  const selected = fieldList.join(", ");
  const whereClause = params.syncFrom
    ? ` WHERE LastModifiedDate >= ${toSalesforceDateLiteral(params.syncFrom)}`
    : "";
  return `SELECT ${selected} FROM ${params.objectSpec.objectName}${whereClause} ORDER BY LastModifiedDate ASC, Id ASC LIMIT ${params.batchSize}`;
}

function salesforceRecordToDocument(params: {
  objectName: string;
  record: SfRecord;
  instanceUrl: string;
}): ConnectorDocument {
  const recordId = String(params.record.Id ?? "");
  if (!recordId) {
    throw new Error("Salesforce record missing Id");
  }

  const title = buildRecordTitle(params.objectName, params.record, recordId);

  // Build field content, excluding internal/nested keys
  const excludeKeys = new Set(["attributes", "CaseComments"]);
  const flatFields = Object.entries(params.record)
    .filter(([key]) => !excludeKeys.has(key))
    .map(([key, value]) => `**${key}:** ${serializeValue(value)}`);

  const contentParts = [`# ${params.objectName}: ${title}`, "", ...flatFields];

  // Append Case Comments as a thread (like Linear appends issue comments)
  const caseComments = params.record.CaseComments;
  if (caseComments?.records && caseComments.records.length > 0) {
    contentParts.push("", "## Comments", "");
    for (const comment of caseComments.records) {
      const date = comment.CreatedDate
        ? new Date(comment.CreatedDate).toISOString()
        : "unknown date";
      contentParts.push(
        "---",
        `**${date}**`,
        comment.CommentBody ?? "(empty comment)",
        "",
      );
    }
  }

  // Truncate content to MAX_CONTENT_LENGTH (matching GDrive pattern)
  const content = contentParts.join("\n").slice(0, MAX_CONTENT_LENGTH);
  const sourceUrl = params.instanceUrl
    ? `${params.instanceUrl}/${recordId}`
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
    },
    updatedAt: lastModified ? new Date(lastModified) : undefined,
  };
}

/** Build a human-readable title, preferring Name then CaseNumber+Subject. */
function buildRecordTitle(
  objectName: string,
  record: SfRecord,
  recordId: string,
): string {
  if (record.Name) return String(record.Name);
  if (record.CaseNumber) {
    const subject = record.Subject ? ` — ${String(record.Subject)}` : "";
    return `Case #${String(record.CaseNumber)}${subject}`;
  }
  return `${objectName} ${recordId.slice(0, 8)}`;
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
  for (const base of BASE_FIELDS) {
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
  record: SfRecord;
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
  return buildCheckpoint({
    type: "salesforce",
    itemUpdatedAt: params.progress.maxLastSyncedAt,
    previousLastSyncedAt: params.previous.lastSyncedAt,
    extra: {
      objectCursorMap: params.progress.objectCursorMap,
    },
  });
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
