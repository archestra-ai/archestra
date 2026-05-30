import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./api-fixtures";

const AUDIT_LOGS_PATH = "/api/audit-logs";

type AuditLogRow = {
  id: string;
  eventSequence: number;
  organizationId: string;
  occurredAt: string;
  createdAt: string;
  actorId: string | null;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  outcome: string;
  resourceType: string | null;
  resourceId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  requestId: string | null;
  sourceIp: string | null;
  userAgent: string | null;
};

type AuditLogsResponse = {
  data: AuditLogRow[];
  pagination: {
    currentPage: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
};

type MakeApiRequest = (args: {
  request: APIRequestContext;
  method: "get" | "post" | "put" | "patch" | "delete";
  urlSuffix: string;
  data?: unknown;
  headers?: Record<string, string>;
  ignoreStatusCheck?: boolean;
}) => Promise<{ status: () => number; json: () => Promise<unknown> }>;

async function fetchAuditLogs(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  query: Record<string, string | number | undefined>,
): Promise<AuditLogsResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      params.append(key, String(value));
    }
  }
  const suffix = `${AUDIT_LOGS_PATH}${params.size ? `?${params.toString()}` : ""}`;
  const response = await makeApiRequest({
    request,
    method: "get",
    urlSuffix: suffix,
  });
  return (await response.json()) as AuditLogsResponse;
}

async function waitForAuditRow(
  makeApiRequest: MakeApiRequest,
  request: APIRequestContext,
  match: (row: AuditLogRow) => boolean,
  query: Record<string, string | number | undefined>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<AuditLogRow | undefined> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 500;
  for (let i = 0; i < attempts; i++) {
    const logs = await fetchAuditLogs(makeApiRequest, request, query);
    const found = logs.data.find(match);
    if (found) return found;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}

test.describe("Audit log API", () => {
  test("records an agent create with before=null and a populated after", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const agentName = `audit-create-${Date.now()}`;
    const created = await createAgent(adminRequest, agentName, "personal");
    const agent = (await created.json()) as { id: string; name: string };

    try {
      const row = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "agent.created", limit: 50 },
      );

      expect(row, "audit row for agent create not found").toBeDefined();
      expect(row?.action).toBe("agent.created");
      expect(row?.outcome).toBe("success");
      expect(row?.resourceType).toBe("agent");
      expect(row?.httpMethod).toBe("POST");
      expect(row?.httpStatus).toBeGreaterThanOrEqual(200);
      expect(row?.httpStatus).toBeLessThan(300);
      expect(row?.before).toBeNull();
      expect(row?.after).not.toBeNull();
      expect(row?.after).toMatchObject({ id: agent.id });
      // Denormalized actor snapshot must be present.
      expect(row?.actorEmail).toBeTruthy();
      // New fields must be populated.
      expect(row?.actorType).toBe("user");
      expect(row?.occurredAt).toBeTruthy();
      expect(typeof row?.eventSequence).toBe("number");
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("records an agent update with before and after differing on the changed field", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const initialName = `audit-update-initial-${Date.now()}`;
    const renamed = `audit-update-renamed-${Date.now()}`;
    const created = await createAgent(adminRequest, initialName, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      await makeApiRequest({
        request: adminRequest,
        method: "put",
        urlSuffix: `/api/agents/${agent.id}`,
        data: { name: renamed },
      });

      const row = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "agent.updated", limit: 50 },
      );

      expect(row, "audit row for agent update not found").toBeDefined();
      expect(row?.action).toBe("agent.updated");
      expect(row?.outcome).toBe("success");
      expect(row?.before).not.toBeNull();
      expect(row?.after).not.toBeNull();
      expect((row?.before as { name?: string })?.name).toBe(initialName);
      expect((row?.after as { name?: string })?.name).toBe(renamed);
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("records an agent delete with before populated and after null", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const name = `audit-delete-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    await deleteAgent(adminRequest, agent.id);

    const row = await waitForAuditRow(
      makeApiRequest,
      adminRequest,
      (r) => r.resourceId === agent.id,
      { resourceType: "agent", action: "agent.deleted", limit: 50 },
    );

    expect(row, "audit row for agent delete not found").toBeDefined();
    expect(row?.action).toBe("agent.deleted");
    expect(row?.outcome).toBe("success");
    expect(row?.before).not.toBeNull();
    expect((row?.before as { id?: string })?.id).toBe(agent.id);
    expect(row?.after).toBeNull();
  });

  test("does not record a row for GET reads", async ({
    adminRequest,
    makeApiRequest,
  }) => {
    // Capture latest createdAt to compare before/after.
    const before = await fetchAuditLogs(makeApiRequest, adminRequest, {
      httpMethod: undefined,
      limit: 1,
    });
    const beforeCreatedAt = before.data[0]?.createdAt;

    // Read-only endpoint should never produce a row.
    await makeApiRequest({
      request: adminRequest,
      method: "get",
      urlSuffix: "/api/agents?limit=1",
    });

    // Small settle to give any (incorrect) async write a chance to land.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await fetchAuditLogs(makeApiRequest, adminRequest, {
      limit: 5,
    });
    // No new row should have appeared above the prior latest.
    if (beforeCreatedAt) {
      const newer = after.data.filter(
        (r) => r.createdAt > beforeCreatedAt && r.httpMethod === "GET",
      );
      expect(newer).toHaveLength(0);
    } else {
      expect(after.data.every((r) => r.httpMethod !== "GET")).toBe(true);
    }
  });

  test("returns 403 to a member account", async ({
    memberRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: memberRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?limit=1`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(403);
  });

  test("returns 403 to an editor account", async ({
    editorRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: editorRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?limit=1`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(403);
  });

  test("rejects an invalid sortDirection with 400", async ({
    adminRequest,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request: adminRequest,
      method: "get",
      urlSuffix: `${AUDIT_LOGS_PATH}?sortDirection=banana`,
      ignoreStatusCheck: true,
    });
    expect(response.status()).toBe(400);
  });

  test("filters narrow results independently", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    const name = `audit-filter-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      const seeded = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "agent.created", limit: 50 },
      );
      expect(seeded).toBeDefined();

      const byResourceType = await fetchAuditLogs(
        makeApiRequest,
        adminRequest,
        { resourceType: "agent", limit: 100 },
      );
      expect(byResourceType.data.length).toBeGreaterThan(0);
      expect(byResourceType.data.every((r) => r.resourceType === "agent")).toBe(
        true,
      );

      const byAction = await fetchAuditLogs(makeApiRequest, adminRequest, {
        action: "agent.created",
        limit: 100,
      });
      expect(byAction.data.every((r) => r.action === "agent.created")).toBe(
        true,
      );

      const bySearch = await fetchAuditLogs(makeApiRequest, adminRequest, {
        search: agent.id,
        limit: 100,
      });
      expect(bySearch.data.some((r) => r.resourceId === agent.id)).toBe(true);
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("outcome filter narrows to matching rows", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Seed a successful mutation to guarantee at least one success row.
    const name = `audit-outcome-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id,
        { resourceType: "agent", action: "agent.created", limit: 50 },
      );

      const successOnly = await fetchAuditLogs(makeApiRequest, adminRequest, {
        outcome: "success",
        limit: 50,
      });
      expect(successOnly.data.length).toBeGreaterThan(0);
      expect(successOnly.data.every((r) => r.outcome === "success")).toBe(true);
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("denied mutation from member produces outcome=denied audit row", async ({
    adminRequest,
    memberRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Admin creates an agent.
    const name = `audit-denied-${Date.now()}`;
    const created = await createAgent(adminRequest, name, "personal");
    const agent = (await created.json()) as { id: string };

    try {
      // Member attempts to delete — expect 403.
      const deleteResp = await makeApiRequest({
        request: memberRequest,
        method: "delete",
        urlSuffix: `/api/agents/${agent.id}`,
        ignoreStatusCheck: true,
      });
      expect(deleteResp.status()).toBe(403);

      // Wait for the denied audit row to appear.
      const row = await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent.id && r.outcome === "denied",
        { resourceType: "agent", limit: 50 },
      );

      expect(row, "audit row for denied agent delete not found").toBeDefined();
      expect(row?.action).toBe("agent.deleted");
      expect(row?.outcome).toBe("denied");
      expect(row?.httpStatus).toBe(403);
      // Before should be captured (preHandler ran); after should be null (denied).
      expect(row?.after).toBeNull();
    } finally {
      await deleteAgent(adminRequest, agent.id);
    }
  });

  test("event_sequence provides deterministic ordering for same-org rows", async ({
    adminRequest,
    makeApiRequest,
    createAgent,
    deleteAgent,
  }) => {
    // Create two agents rapidly so they land with close timestamps.
    const name1 = `audit-seq-a-${Date.now()}`;
    const name2 = `audit-seq-b-${Date.now()}`;
    const [created1, created2] = await Promise.all([
      createAgent(adminRequest, name1, "personal"),
      createAgent(adminRequest, name2, "personal"),
    ]);
    const agent1 = (await created1.json()) as { id: string };
    const agent2 = (await created2.json()) as { id: string };

    try {
      // Wait until both rows appear.
      await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent1.id,
        { action: "agent.created", limit: 50 },
      );
      await waitForAuditRow(
        makeApiRequest,
        adminRequest,
        (r) => r.resourceId === agent2.id,
        { action: "agent.created", limit: 50 },
      );

      // Fetch the latest rows; event_sequence should be strictly descending.
      const logs = await fetchAuditLogs(makeApiRequest, adminRequest, {
        action: "agent.created",
        limit: 10,
      });

      const sequences = logs.data.map((r) => r.eventSequence);
      for (let i = 1; i < sequences.length; i++) {
        expect(
          sequences[i - 1],
          `event_sequence must be strictly descending: ${sequences[i - 1]} > ${sequences[i]}`,
        ).toBeGreaterThan(sequences[i]);
      }
    } finally {
      await Promise.all([
        deleteAgent(adminRequest, agent1.id),
        deleteAgent(adminRequest, agent2.id),
      ]);
    }
  });
});
