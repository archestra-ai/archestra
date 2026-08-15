import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConnectorSyncBatch, PermissionSnapshotYield } from "@/types";
import { SalesforceConnector } from "./salesforce-connector";

// ===== jsforce mock (class-based, matching Linear connector test pattern) =====

const mockLogin = vi.fn();
const mockQuery = vi.fn();
const mockQueryMore = vi.fn();
const mockMetadataRead = vi.fn();
const mockDeleted = vi.fn();

vi.mock("jsforce", () => {
  class MockConnection {
    instanceUrl = "https://acme.my.salesforce.com";
    login = mockLogin;
    query = mockQuery;
    queryMore = mockQueryMore;
    metadata = { read: mockMetadataRead };
    deleted = mockDeleted;
  }
  return { Connection: MockConnection };
});

afterEach(() => {
  mockLogin.mockReset();
  mockQuery.mockReset();
  mockQueryMore.mockReset();
  mockMetadataRead.mockReset();
  mockDeleted.mockReset();
});

const CREDS = { email: "test@example.com", apiToken: "pass+token" };

// ===== Helpers =====

async function collectBatches(
  gen: AsyncGenerator<ConnectorSyncBatch>,
): Promise<ConnectorSyncBatch[]> {
  const batches: ConnectorSyncBatch[] = [];
  for await (const b of gen) batches.push(b);
  return batches;
}

// ===== Tests =====

describe("SalesforceConnector", () => {
  test("exposes salesforce connector type", () => {
    expect(new SalesforceConnector().type).toBe("salesforce");
  });

  // ----- validateConfig -----

  describe("validateConfig", () => {
    test("accepts minimal valid config", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({});
      expect(r).toEqual({ valid: true });
    });

    test("rejects array JSON in advancedObjectConfigJson", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        advancedObjectConfigJson: "[1,2,3]",
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("advancedObjectConfigJson");
    });

    test("rejects unparseable JSON", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        advancedObjectConfigJson: "not json",
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("advancedObjectConfigJson");
    });

    test("accepts valid advanced object config", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        advancedObjectConfigJson: JSON.stringify({
          Lead: { fields: ["FirstName"] },
        }),
      });
      expect(r).toEqual({ valid: true });
    });

    test("rejects loginUrl with non-HTTP protocol", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        loginUrl: "ftp://login.salesforce.com",
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("loginUrl");
    });

    test("rejects unsafe characters in object names", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({ objects: ["Account; DROP TABLE"] });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("Invalid object name");
    });

    test("rejects unsafe field names in advanced config", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        advancedObjectConfigJson: JSON.stringify({
          Account: { fields: ["Name; --"] },
        }),
      });
      expect(r.valid).toBe(false);
      expect(r.error).toContain("Invalid field name");
    });

    test("accepts valid custom object __c names and relationship fields", async () => {
      const c = new SalesforceConnector();
      const r = await c.validateConfig({
        advancedObjectConfigJson: JSON.stringify({
          Custom__c: {
            fields: ["Custom_Field__c"],
            associations: { Account: ["Name"] },
          },
        }),
      });
      expect(r).toEqual({ valid: true });
    });

    test("accepts valid Salesforce API name suffixes beyond __c/__r (e.g. __kav, __mdt, __b)", async () => {
      const c = new SalesforceConnector();

      const r1 = await c.validateConfig({ objects: ["Knowledge__kav"] });
      expect(r1).toEqual({ valid: true });

      const r2 = await c.validateConfig({
        advancedObjectConfigJson: JSON.stringify({
          CustomMetadata__mdt: { fields: ["DeveloperName"] },
          BigObject__b: { fields: ["Id"] },
        }),
      });
      expect(r2).toEqual({ valid: true });
    });

    test("trims objects and defaults to core objects when objects is empty", async () => {
      const c = new SalesforceConnector();
      // Should not reject and should succeed even with whitespace and empties.
      const r = await c.validateConfig({
        objects: ["  Account  ", " ", "Contact"],
      });
      expect(r).toEqual({ valid: true });

      // Empty list should not fail validation.
      const r2 = await c.validateConfig({ objects: [] });
      expect(r2).toEqual({ valid: true });
    });
  });

  // ----- testConnection -----

  describe("testConnection", () => {
    test("returns success for valid credentials", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 1,
        records: [{ Id: "005123" }],
      });

      const r = await c.testConnection({ config: {}, credentials: CREDS });

      expect(r.success).toBe(true);
      expect(mockLogin).toHaveBeenCalledWith("test@example.com", "pass+token");
      expect(mockQuery).toHaveBeenCalledWith("SELECT Id FROM User LIMIT 1");
    });

    test("returns failure for login error", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockRejectedValueOnce(
        new Error("INVALID_LOGIN: Invalid username or password"),
      );

      const r = await c.testConnection({ config: {}, credentials: CREDS });

      expect(r.success).toBe(false);
      expect(r.error).toContain("INVALID_LOGIN");
    });

    test("returns failure for missing credentials", async () => {
      const c = new SalesforceConnector();
      const r = await c.testConnection({
        config: {},
        credentials: { apiToken: "" },
      });

      expect(r.success).toBe(false);
      expect(r.error).toContain("Missing Salesforce username");
    });
  });

  // ----- estimateTotalItems -----

  describe("estimateTotalItems", () => {
    test("returns total count across objects", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery
        .mockResolvedValueOnce({ totalSize: 50 })
        .mockResolvedValueOnce({ totalSize: 30 })
        .mockResolvedValueOnce({ totalSize: 10 })
        .mockResolvedValueOnce({ totalSize: 5 });

      const total = await c.estimateTotalItems({
        config: {},
        credentials: CREDS,
        checkpoint: null,
      });

      expect(total).toBe(95);
    });

    test("returns null when login fails", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockRejectedValueOnce(new Error("auth failed"));

      const total = await c.estimateTotalItems({
        config: {},
        credentials: CREDS,
        checkpoint: null,
      });

      expect(total).toBeNull();
    });
  });

  // ----- sync -----

  describe("sync", () => {
    test("syncs all four default objects in simple mode", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery
        // Account
        .mockResolvedValueOnce({
          done: true,
          totalSize: 1,
          records: [
            {
              attributes: { type: "Account" },
              Id: "001A",
              Name: "Acme Corp",
              Industry: "Technology",
              LastModifiedDate: "2026-04-19T10:00:00.000Z",
            },
          ],
        })
        // Contact
        .mockResolvedValueOnce({
          done: true,
          totalSize: 1,
          records: [
            {
              attributes: { type: "Contact" },
              Id: "003A",
              Name: "Jane Doe",
              Email: "jane@acme.com",
              LastModifiedDate: "2026-04-19T11:00:00.000Z",
            },
          ],
        })
        // Opportunity
        .mockResolvedValueOnce({
          done: true,
          totalSize: 0,
          records: [],
        })
        // Case
        .mockResolvedValueOnce({
          done: true,
          totalSize: 0,
          records: [],
        });

      const batches = await collectBatches(
        c.sync({ config: {}, credentials: CREDS, checkpoint: null }),
      );

      // One batch per default object
      expect(batches).toHaveLength(4);
      expect(batches[0].documents[0].id).toBe("salesforce:Account:001A");
      expect(batches[0].documents[0].title).toBe("Acme Corp");
      expect(batches[0].documents[0].sourceUrl).toBe(
        "https://acme.my.salesforce.com/001A",
      );
      expect(batches[0].documents[0].content).toContain(
        "**Industry:** Technology",
      );
      expect(batches[1].documents[0].id).toBe("salesforce:Contact:003A");

      // hasMore flags
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(true);
      expect(batches[2].hasMore).toBe(true);
      expect(batches[3].hasMore).toBe(false);

      // Verify SOQL includes per-object fields
      const soqls = mockQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(soqls[0]).toContain("FROM Account");
      expect(soqls[0]).toContain("Industry");
      expect(soqls[1]).toContain("FROM Contact");
      expect(soqls[1]).toContain("Email");
      expect(soqls[2]).toContain("FROM Opportunity");
      expect(soqls[2]).toContain("StageName");
      expect(soqls[3]).toContain("FROM Case");
      expect(soqls[3]).toContain("CaseComments");
    });

    test("syncs Case with CaseComments as threaded content", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 1,
        records: [
          {
            attributes: { type: "Case" },
            Id: "500A",
            CaseNumber: "00001001",
            Subject: "Cannot log in",
            Status: "New",
            LastModifiedDate: "2026-04-20T09:00:00.000Z",
            CaseComments: {
              totalSize: 2,
              done: true,
              records: [
                {
                  CommentBody: "I tried rebooting",
                  CreatedDate: "2026-04-20T09:30:00.000Z",
                },
                {
                  CommentBody: "Issue resolved after clearing cache",
                  CreatedDate: "2026-04-20T10:00:00.000Z",
                },
              ],
            },
          },
        ],
      });

      const batches = await collectBatches(
        c.sync({
          config: { objects: ["Case"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(1);
      const doc = batches[0].documents[0];
      expect(doc.id).toBe("salesforce:Case:500A");
      expect(doc.title).toBe("Case #00001001 — Cannot log in");
      expect(doc.content).toContain("## Comments");
      expect(doc.content).toContain("I tried rebooting");
      expect(doc.content).toContain("Issue resolved after clearing cache");
      // CaseComments should NOT appear as a flat field
      expect(doc.content).not.toContain("**CaseComments:**");
    });

    test("uses advanced object config fields and associations", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 1,
        records: [
          {
            attributes: { type: "Lead" },
            Id: "00QA",
            FirstName: "Ada",
            LastName: "Lovelace",
            Name: "Ada Lovelace",
            LastModifiedDate: "2026-04-20T08:30:00.000Z",
          },
        ],
      });

      const batches = await collectBatches(
        c.sync({
          config: {
            advancedObjectConfigJson: JSON.stringify({
              Lead: {
                fields: ["FirstName", "LastName"],
                associations: { Account: ["Name"] },
              },
            }),
          },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(1);
      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("FROM Lead");
      expect(soql).toContain("FirstName");
      expect(soql).toContain("LastName");
      // Association fields should be in SOQL as relationship fields
      expect(soql).toContain("Account.Name");
      expect(batches[0].documents[0].content).toContain("**FirstName:** Ada");
    });

    test("does not implicitly append Name for advanced object configs", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 1,
        records: [
          {
            attributes: { type: "Lead" },
            Id: "00QA",
            FirstName: "Ada",
            LastName: "Lovelace",
            LastModifiedDate: "2026-04-20T08:30:00.000Z",
          },
        ],
      });

      await collectBatches(
        c.sync({
          config: {
            advancedObjectConfigJson: JSON.stringify({
              Lead: {
                fields: ["FirstName", "LastName"],
                associations: {},
              },
            }),
          },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("FROM Lead");
      expect(soql).toContain("FirstName");
      expect(soql).toContain("LastName");
      expect(soql).toContain("Id");
      expect(soql).toContain("LastModifiedDate");
      expect(soql).not.toMatch(/\bName\b/);
    });

    test("handles pagination via queryMore", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: false,
        totalSize: 2,
        nextRecordsUrl: "/services/data/v60.0/query/01gNEXT",
        records: [
          {
            attributes: { type: "Account" },
            Id: "001P1",
            Name: "Page One",
            LastModifiedDate: "2026-04-20T01:00:00.000Z",
          },
        ],
      });
      mockQueryMore.mockResolvedValueOnce({
        done: true,
        totalSize: 2,
        records: [
          {
            attributes: { type: "Account" },
            Id: "001P2",
            Name: "Page Two",
            LastModifiedDate: "2026-04-20T02:00:00.000Z",
          },
        ],
      });

      const batches = await collectBatches(
        c.sync({
          config: { objects: ["Account"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(2);
      expect(batches[0].hasMore).toBe(true);
      expect(batches[1].hasMore).toBe(false);
      expect(mockQueryMore).toHaveBeenCalledWith(
        "/services/data/v60.0/query/01gNEXT",
      );
    });

    test("applies incremental LastModifiedDate lower bound from checkpoint", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 0,
        records: [],
      });

      await collectBatches(
        c.sync({
          config: { objects: ["Contact"] },
          credentials: CREDS,
          checkpoint: {
            type: "salesforce",
            objectCursorMap: { Contact: "2026-04-20T10:00:00.000Z" },
            lastSyncedAt: "2026-04-20T10:00:00.000Z",
          },
        }),
      );

      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("FROM Contact");
      expect(soql).toContain("LastModifiedDate >=");
    });

    test("advances checkpoint monotonically with per-object cursors", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 1,
        records: [
          {
            attributes: { type: "Account" },
            Id: "001A",
            Name: "Acme",
            LastModifiedDate: "2026-04-19T10:00:00.000Z",
          },
        ],
      });

      const batches = await collectBatches(
        c.sync({
          config: { objects: ["Account"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      expect(batches[0].checkpoint.type).toBe("salesforce");
      const cp = batches[0].checkpoint as {
        objectCursorMap?: Record<string, string>;
        lastSyncedAt?: string;
      };
      expect(cp.objectCursorMap?.Account).toBe("2026-04-19T10:00:00.000Z");
      expect(cp.lastSyncedAt).toBe("2026-04-19T10:00:00.000Z");
    });

    test("continues to next object when one object query fails (per-object resilience)", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery
        // Account — fails
        .mockRejectedValueOnce(
          new Error("sObject type 'Account' is not supported"),
        )
        // Contact — succeeds
        .mockResolvedValueOnce({
          done: true,
          totalSize: 1,
          records: [
            {
              attributes: { type: "Contact" },
              Id: "003A",
              Name: "Jane",
              LastModifiedDate: "2026-04-19T11:00:00.000Z",
            },
          ],
        });

      const batches = await collectBatches(
        c.sync({
          config: { objects: ["Account", "Contact"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      // Should get 2 batches: failure batch for Account + success batch for Contact
      expect(batches).toHaveLength(2);

      // First batch: Account failure recorded
      expect(batches[0].documents).toHaveLength(0);
      expect(batches[0].failures).toBeDefined();
      expect(batches[0].failures?.length).toBeGreaterThanOrEqual(1);
      expect(batches[0].failures?.[0].error).toContain("Query failed");
      expect(batches[0].hasMore).toBe(true); // Contact still pending

      // Second batch: Contact succeeds
      expect(batches[1].documents).toHaveLength(1);
      expect(batches[1].documents[0].id).toBe("salesforce:Contact:003A");
      expect(batches[1].hasMore).toBe(false);
    });

    test("isolates per-item failures without aborting sync", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 2,
        records: [
          { attributes: { type: "Account" } }, // missing Id → per-item failure
          {
            attributes: { type: "Account" },
            Id: "001B",
            Name: "Good Record",
            LastModifiedDate: "2026-04-19T10:00:00.000Z",
          },
        ],
      });

      const batches = await collectBatches(
        c.sync({
          config: { objects: ["Account"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      expect(batches).toHaveLength(1);
      // Good record still appears
      expect(batches[0].documents).toHaveLength(1);
      expect(batches[0].documents[0].id).toBe("salesforce:Account:001B");
      // Bad record reported as failure
      expect(batches[0].failures?.length).toBeGreaterThanOrEqual(1);
      expect(batches[0].failures?.[0].error).toContain("missing Id");
    });

    test("uses per-object default fields rather than bare Id/Name/LastModifiedDate", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 0,
        records: [],
      });

      await collectBatches(
        c.sync({
          config: { objects: ["Account"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("Industry");
      expect(soql).toContain("Phone");
      expect(soql).toContain("BillingCity");
    });

    test("falls back to base fields for unknown custom objects", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 0,
        records: [],
      });

      await collectBatches(
        c.sync({
          config: { objects: ["CustomObj__c"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("FROM CustomObj__c");
      expect(soql).toContain("Id");
      expect(soql).toContain("LastModifiedDate");
      expect(soql).not.toContain("Name");
      expect(soql).not.toContain("Industry");
    });

    test("uses Knowledge__kav default fields when specified as object", async () => {
      const c = new SalesforceConnector();
      mockLogin.mockResolvedValueOnce({});
      mockQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 0,
        records: [],
      });

      await collectBatches(
        c.sync({
          config: { objects: ["Knowledge__kav"] },
          credentials: CREDS,
          checkpoint: null,
        }),
      );

      const soql = mockQuery.mock.calls[0][0] as string;
      expect(soql).toContain("FROM Knowledge__kav");
      expect(soql).toContain("Title");
      expect(soql).toContain("Summary");
      expect(soql).toContain("ArticleNumber");
    });
  });

  // ----- permission sync -----

  describe("permission sync", () => {
    type ContainerYield = Extract<
      PermissionSnapshotYield,
      { kind: "container" }
    >;
    type DocumentYield = Extract<PermissionSnapshotYield, { kind: "document" }>;

    const permConfig = { type: "salesforce", objects: ["Account"] };

    function collectSnapshot(
      gen: AsyncGenerator<PermissionSnapshotYield> | undefined,
    ) {
      const containers = new Map<string, ContainerYield>();
      const documents: DocumentYield[] = [];
      return (async () => {
        for await (const item of gen ??
          ((async function* () {})() as AsyncGenerator<PermissionSnapshotYield>)) {
          if (item.kind === "container")
            containers.set(item.containerKey, item);
          else documents.push(item);
        }
        return { containers, documents };
      })();
    }

    function readBack(sourceIds: string[], objectName = "Account") {
      return vi.fn(async () => ({
        documents: sourceIds.map((id) => ({
          sourceId: `salesforce:${objectName}:${id}`,
          metadata: { objectName },
        })),
        nextAfterId: null,
      }));
    }

    function syncParams(overrides?: {
      config?: Record<string, unknown>;
      sourceIds?: string[];
      objectName?: string;
    }) {
      return {
        config: overrides?.config ?? permConfig,
        credentials: CREDS,
        cursor: null,
        readIngestedDocuments: readBack(
          overrides?.sourceIds ?? ["001A"],
          overrides?.objectName ?? "Account",
        ),
      };
    }

    /** SOQL router: match on FROM/WHERE content. */
    function stubSoql(routes: Array<{ match: string; records: unknown[] }>) {
      mockQuery.mockImplementation((soql: string) => {
        const route = routes.find((r) => soql.includes(r.match));
        if (!route) throw new Error(`No route for SOQL: ${soql}`);
        return Promise.resolve({ done: true, records: route.records });
      });
    }

    test("supportsPermissionSync is true", () => {
      expect(new SalesforceConnector().supportsPermissionSync).toBe(true);
    });

    test("public OWD (Read) → isPublic container, documents assign top-level", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "Read" });
      stubSoql([]); // no SOQL expected on the public path

      const { containers, documents } = await collectSnapshot(
        c.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("sobject:Account")?.permissions).toEqual({
        isPublic: true,
      });
      expect(documents).toEqual([
        {
          kind: "document",
          sourceId: "salesforce:Account:001A",
          containerKey: "sobject:Account",
          cursor: "sobject:Account",
        },
      ]);
    });

    test("private OWD → per-record nested containers with owner + share audience", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "Private" });
      stubSoql([
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001A", OwnerId: "005OWNER" }],
        },
        {
          match: "FROM AccountShare",
          records: [
            {
              ParentId: "001A",
              UserOrGroupId: "005SHARED",
              RowCause: "Manual",
            },
            {
              ParentId: "001A",
              UserOrGroupId: "00GGROUP",
              RowCause: "Rule",
            },
            // Owner row cause must not duplicate the owner grant.
            {
              ParentId: "001A",
              UserOrGroupId: "005OWNER",
              RowCause: "Owner",
            },
          ],
        },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005OWNER", Email: "Owner@Example.com", IsActive: true },
            { Id: "005SHARED", Email: "shared@example.com", IsActive: true },
          ],
        },
      ]);

      const { containers, documents } = await collectSnapshot(
        c.syncPermissionSnapshot(syncParams()),
      );

      const nested = containers.get("sobject:Account/record:001A");
      expect(nested?.permissions).toEqual({
        isPublic: false,
        users: ["owner@example.com", "shared@example.com"],
        groups: ["00GGROUP"],
      });
      expect(documents[0]?.containerKey).toBe("sobject:Account/record:001A");
    });

    test("metadata read failure treats the object as Private (safe direction)", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockRejectedValue(new Error("INVALID_TYPE"));
      stubSoql([
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001A", OwnerId: "005OWNER" }],
        },
        { match: "FROM AccountShare", records: [] },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005OWNER", Email: "owner@example.com", IsActive: true },
          ],
        },
      ]);

      const { containers } = await collectSnapshot(
        c.syncPermissionSnapshot(syncParams()),
      );

      expect(containers.get("sobject:Account")?.permissions).toEqual({
        isPublic: false,
        users: [],
        groups: [],
      });
      expect(
        containers.get("sobject:Account/record:001A")?.permissions.users,
      ).toEqual(["owner@example.com"]);
    });

    test("unqueryable share table degrades the object to owner-only (fail-closed)", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "Private" });
      mockQuery.mockImplementation((soql: string) => {
        if (soql.includes("FROM AccountShare")) {
          return Promise.reject(new Error("INVALID_ENTITY"));
        }
        if (soql.includes("FROM Account WHERE Id IN")) {
          return Promise.resolve({
            done: true,
            records: [{ Id: "001A", OwnerId: "005OWNER" }],
          });
        }
        if (soql.includes("FROM User WHERE Id IN")) {
          return Promise.resolve({
            done: true,
            records: [
              { Id: "005OWNER", Email: "owner@example.com", IsActive: true },
            ],
          });
        }
        return Promise.reject(new Error(`No route: ${soql}`));
      });

      const { containers } = await collectSnapshot(
        c.syncPermissionSnapshot(syncParams()),
      );

      expect(
        containers.get("sobject:Account/record:001A")?.permissions,
      ).toEqual({
        isPublic: false,
        users: ["owner@example.com"],
        groups: [],
      });
    });

    test("queue-owned records grant the owning group (00G owner)", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "Private" });
      stubSoql([
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001A", OwnerId: "00GQUEUE" }],
        },
        { match: "FROM AccountShare", records: [] },
      ]);

      const { containers } = await collectSnapshot(
        c.syncPermissionSnapshot(syncParams()),
      );

      expect(
        containers.get("sobject:Account/record:001A")?.permissions.groups,
      ).toEqual(["00GQUEUE"]);
    });

    test("Contact inherits its parent Account's audience; orphan contact is owner-only", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockImplementation((_type: string, name: string) =>
        Promise.resolve({
          sharingModel: name === "Contact" ? "ControlledByParent" : "Private",
        }),
      );
      stubSoql([
        {
          match: "FROM Contact WHERE Id IN",
          records: [
            { Id: "003A", AccountId: "001P", OwnerId: "005C" },
            { Id: "003B", AccountId: null, OwnerId: "005C" },
          ],
        },
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001P", OwnerId: "005P" }],
        },
        {
          match: "FROM AccountShare",
          records: [
            { ParentId: "001P", UserOrGroupId: "005TEAM", RowCause: "Team" },
          ],
        },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005P", Email: "p@example.com", IsActive: true },
            { Id: "005TEAM", Email: "team@example.com", IsActive: true },
            { Id: "005C", Email: "c@example.com", IsActive: true },
          ],
        },
      ]);

      const { containers } = await collectSnapshot(
        c.syncPermissionSnapshot(
          syncParams({
            config: { type: "salesforce", objects: ["Contact"] },
            sourceIds: ["003A", "003B"],
            objectName: "Contact",
          }),
        ),
      );

      expect(
        containers.get("sobject:Contact/record:003A")?.permissions,
      ).toEqual({
        isPublic: false,
        users: ["p@example.com", "team@example.com"],
        groups: [],
      });
      expect(
        containers.get("sobject:Contact/record:003B")?.permissions.users,
      ).toEqual(["c@example.com"]);
    });

    test("syncGroups: recursive expansion, inactive users dropped, byte-matching group ids", async () => {
      const c = new SalesforceConnector();
      stubSoql([
        {
          match: "FROM GroupMember",
          records: [
            { GroupId: "00G1", UserOrGroupId: "00G2" },
            { GroupId: "00G1", UserOrGroupId: "005A" },
            { GroupId: "00G2", UserOrGroupId: "005B" },
            { GroupId: "00G2", UserOrGroupId: "005INACTIVE" },
          ],
        },
        {
          match: "FROM Group",
          records: [
            { Id: "00G1", Name: "Outer", Type: "Regular" },
            { Id: "00G2", Name: "Inner", Type: "Regular" },
          ],
        },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005A", Email: "a@example.com", IsActive: true },
            { Id: "005B", Email: "b@example.com", IsActive: true },
            { Id: "005INACTIVE", Email: "gone@example.com", IsActive: false },
          ],
        },
      ]);

      const yields = [];
      for await (const item of c.syncGroups(syncParams()) ?? []) {
        yields.push(item);
      }

      const outer = yields.find((y) => y.groupId === "00G1");
      const inner = yields.find((y) => y.groupId === "00G2");
      expect(outer?.members.map((m) => m.email).sort()).toEqual([
        "a@example.com",
        "b@example.com",
        null,
      ]);
      expect(inner?.members.map((m) => m.email).sort()).toEqual([
        "b@example.com",
        null,
      ]);
    });

    test("syncGroups: direct grant-holders roster under direct-grants (owners + user share grantees; hidden emails stay visible)", async () => {
      const c = new SalesforceConnector();
      stubSoql([
        { match: "FROM Group", records: [] },
        { match: "FROM GroupMember", records: [] },
        {
          match: "FROM Account GROUP BY OwnerId",
          records: [{ OwnerId: "005OWNER" }, { OwnerId: "00GQUEUE" }],
        },
        {
          match: "FROM AccountShare GROUP BY UserOrGroupId",
          records: [
            { UserOrGroupId: "005SHAREE", RowCause: "Manual" },
            // Guest and Owner causes never roster.
            { UserOrGroupId: "005GUEST", RowCause: "GuestRule" },
            { UserOrGroupId: "005OWNROW", RowCause: "Owner" },
            { UserOrGroupId: "00GGRP", RowCause: "Manual" },
          ],
        },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005OWNER", Email: "Owner@Example.com", IsActive: true },
            // No row for 005SHAREE — unresolvable, stays rostered email-less.
          ],
        },
      ]);

      const yields = [];
      for await (const item of c.syncGroups(syncParams()) ?? []) {
        yields.push(item);
      }

      expect(yields).toEqual([
        {
          groupId: "direct-grants",
          members: [
            {
              accountId: "005OWNER",
              displayName: null,
              email: "owner@example.com",
            },
            { accountId: "005SHAREE", displayName: null, email: null },
          ],
          cursor: undefined,
        },
      ]);
    });

    test("member override maps a direct grantee whose Salesforce email is hidden", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "Private" });
      stubSoql([
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001A", OwnerId: "005HIDDEN" }],
        },
        {
          match: "FROM AccountShare",
          records: [
            {
              ParentId: "001A",
              UserOrGroupId: "005MAPPED",
              RowCause: "Manual",
            },
          ],
        },
        // Neither user resolves an email upstream.
        { match: "FROM User WHERE Id IN", records: [] },
      ]);

      const { containers } = await collectSnapshot(
        c.syncPermissionSnapshot({
          ...syncParams(),
          resolveMappedEmail: (accountId: string) =>
            accountId === "005MAPPED" ? "Mapped@Corp.Test" : null,
        }),
      );

      // The override materializes the share grant; the unmapped owner stays
      // dropped fail-closed.
      expect(
        containers.get("sobject:Account/record:001A")?.permissions.users,
      ).toEqual(["mapped@corp.test"]);
    });

    test("probe: first probe requires full reconcile; share delete dirties the object; Account drift dirties Contact", async () => {
      const c = new SalesforceConnector();

      const first = await c.probePermissionChanges({
        config: { type: "salesforce", objects: ["Account", "Contact"] },
        credentials: CREDS,
        state: null,
      });
      expect(first.fullRequired).toBe(true);
      expect(typeof first.nextState.soqlCursor).toBe("string");

      // Second probe: no record edits, no share edits, one share deletion
      // on AccountShare → Account dirty, Contact inherited-dirty.
      mockQuery.mockResolvedValue({ done: true, records: [] });
      mockDeleted.mockImplementation((obj: string) =>
        obj === "AccountShare"
          ? Promise.resolve({ deletedRecords: [{ id: "00rX" }] })
          : Promise.resolve({ deletedRecords: [] }),
      );

      const second = await c.probePermissionChanges({
        config: { type: "salesforce", objects: ["Account", "Contact"] },
        credentials: CREDS,
        state: { soqlCursor: new Date().toISOString() },
      });
      expect(second.fullRequired).toBe(false);
      expect(second.dirtyContainerKeys).toEqual([
        "sobject:Account",
        "sobject:Contact",
      ]);
    });

    test("probe: getDeleted unsupported → the object is always dirty (deletions invisible)", async () => {
      const c = new SalesforceConnector();
      mockQuery.mockResolvedValue({ done: true, records: [] });
      mockDeleted.mockRejectedValue(new Error("UNSUPPORTED"));

      const result = await c.probePermissionChanges({
        config: { type: "salesforce", objects: ["Account"] },
        credentials: CREDS,
        state: { soqlCursor: new Date().toISOString() },
      });
      expect(result.dirtyContainerKeys).toEqual(["sobject:Account"]);
    });

    test("refreshContainerAudiences re-resolves top-level OWD and nested record audiences", async () => {
      const c = new SalesforceConnector();
      mockMetadataRead.mockResolvedValue({ sharingModel: "ReadWrite" });
      stubSoql([
        {
          match: "FROM Account WHERE Id IN",
          records: [{ Id: "001A", OwnerId: "005OWNER" }],
        },
        { match: "FROM AccountShare", records: [] },
        {
          match: "FROM User WHERE Id IN",
          records: [
            { Id: "005OWNER", Email: "owner@example.com", IsActive: true },
          ],
        },
      ]);

      const yields = [];
      for await (const item of c.refreshContainerAudiences({
        config: permConfig,
        credentials: CREDS,
        containerKeys: [
          "sobject:Account",
          "sobject:Account/record:001A",
          "bogus:key",
        ],
      }) ?? []) {
        yields.push(item);
      }

      expect(yields).toEqual([
        {
          containerKey: "sobject:Account",
          permissions: { isPublic: true },
          audienceResolutionFailed: false,
        },
        {
          containerKey: "sobject:Account/record:001A",
          permissions: {
            isPublic: false,
            users: ["owner@example.com"],
            groups: [],
          },
          audienceResolutionFailed: false,
        },
      ]);
    });

    test("scopeKeyForDocument maps objectName metadata to the object container", () => {
      const c = new SalesforceConnector();
      expect(c.scopeKeyForDocument({ objectName: "Account" })).toBe(
        "sobject:Account",
      );
      expect(c.scopeKeyForDocument({})).toBeNull();
    });
  });
});
