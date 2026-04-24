import { afterEach, describe, expect, test, vi } from "vitest";
import type { ConnectorSyncBatch } from "@/types";
import { SalesforceConnector } from "./salesforce-connector";

// ===== jsforce mock (class-based, matching Linear connector test pattern) =====

const mockLogin = vi.fn();
const mockQuery = vi.fn();
const mockQueryMore = vi.fn();

vi.mock("jsforce", () => {
  class MockConnection {
    instanceUrl = "https://acme.my.salesforce.com";
    login = mockLogin;
    query = mockQuery;
    queryMore = mockQueryMore;
  }
  return { Connection: MockConnection };
});

afterEach(() => {
  mockLogin.mockReset();
  mockQuery.mockReset();
  mockQueryMore.mockReset();
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
});
