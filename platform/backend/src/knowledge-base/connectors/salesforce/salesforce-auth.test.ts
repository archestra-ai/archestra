import { setDispatcher } from "jsforce/lib/request";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import logger from "@/logging";
import { SalesforceConfigSchema } from "@/types";
import { SalesforceConnector } from "./salesforce-connector";

vi.mock("@/logging");

const DOMAIN = "https://example.my.salesforce.com";
const CONFIG = {
  type: "salesforce" as const,
  authMethod: "oauth_client_credentials" as const,
  loginUrl: DOMAIN,
  clientId: "consumer-key",
  objects: ["Account"],
};
const CREDS = { apiToken: "consumer-secret" };
const TOKEN = "access-token";
let agent: MockAgent;

beforeEach(() => {
  // jsforce has its own explicit undici dispatcher, so MSW/global fetch cannot
  // intercept it. Replace only that network boundary, keeping real jsforce.
  agent = new MockAgent();
  agent.disableNetConnect();
  setDispatcher(agent);
});
afterEach(async () => {
  setDispatcher();
  await agent.close();
});

function tokenResponse(accessToken = TOKEN) {
  return {
    access_token: accessToken,
    instance_url: DOMAIN,
    id: `${DOMAIN}/id/00D000000000001/005000000000001`,
    token_type: "Bearer",
  };
}
function queryResponse(records: Record<string, unknown>[] = []) {
  return { records, totalSize: records.length, done: true };
}
function mockToken(
  handler: (body: URLSearchParams) => { statusCode: number; data: unknown },
  statusCode = 200,
) {
  agent
    .get(DOMAIN)
    .intercept({ path: "/services/oauth2/token", method: "POST" })
    .reply(
      statusCode,
      async (options) => {
        // jsforce streams its form body to undici; consume the actual bytes.
        const chunks: Uint8Array[] = [];
        for await (const chunk of options.body as AsyncIterable<Uint8Array>)
          chunks.push(chunk);
        const body = new URLSearchParams(
          Buffer.concat(chunks).toString("utf8"),
        );
        return JSON.stringify(handler(body).data);
      },
      { headers: { "content-type": "application/json" } },
    )
    .persist();
}
function mockQuery(
  handler: (params: { q: string; bearer: string }) => {
    statusCode: number;
    data: unknown;
  },
  origin = DOMAIN,
) {
  agent
    .get(origin)
    .intercept({
      path: (path) => /^\/services\/data\/v[\d.]+\/query\?/.test(path),
      method: "GET",
    })
    .reply((options) => {
      const headers = new Headers(options.headers as Record<string, string>);
      const result = handler({
        q: new URL(options.path, DOMAIN).searchParams.get("q") ?? "",
        bearer: headers.get("authorization") ?? "",
      });
      return {
        ...result,
        data: JSON.stringify(result.data),
        responseOptions: { headers: { "content-type": "application/json" } },
      };
    })
    .persist();
}
function expiredSession() {
  return {
    statusCode: 401,
    data: [{ errorCode: "INVALID_SESSION_ID", message: "Session expired" }],
  };
}

describe("Salesforce OAuth transport", () => {
  test("sends only a client credentials grant and uses its bearer token for content and permission reads", async () => {
    const grants: URLSearchParams[] = [];
    const queries: string[] = [];
    mockToken((body) => {
      grants.push(body);
      return { statusCode: 200, data: tokenResponse() };
    });
    mockQuery(({ q, bearer }) => {
      expect(bearer).toBe(`Bearer ${TOKEN}`);
      queries.push(q);
      return {
        statusCode: 200,
        data: queryResponse(
          q.includes("FROM Account")
            ? [
                {
                  Id: "001000000000001",
                  Name: "Example account",
                  LastModifiedDate: "2026-10-01T00:00:00.000Z",
                },
              ]
            : [],
        ),
      };
    });
    const connector = new SalesforceConnector();
    expect(
      await connector.testConnection({ config: CONFIG, credentials: CREDS }),
    ).toEqual({ success: true });
    const batches = [];
    for await (const batch of connector.sync({
      config: CONFIG,
      credentials: CREDS,
      checkpoint: null,
    }))
      batches.push(batch);
    expect(batches.flatMap((batch) => batch.documents)).toMatchObject([
      {
        id: "salesforce:Account:001000000000001",
        title: "Example account",
      },
    ]);
    for await (const _group of connector.syncGroups({
      config: CONFIG,
      credentials: CREDS,
      cursor: null,
      readIngestedDocuments: async () => ({ documents: [], nextAfterId: null }),
    })) {
      /* empty upstream groups */
    }
    expect(queries.some((q) => q.includes("FROM Group"))).toBe(true);
    expect(grants).toHaveLength(3);
    for (const grant of grants)
      expect(Object.fromEntries(grant)).toEqual({
        grant_type: "client_credentials",
        client_id: CONFIG.clientId,
        client_secret: CREDS.apiToken,
      });
  });

  test("renews an expired session with client credentials and retries with the new token", async () => {
    let grants = 0;
    const bearerTokens: string[] = [];
    mockToken((body) => {
      expect(body.get("grant_type")).toBe("client_credentials");
      return {
        statusCode: 200,
        data: tokenResponse(++grants === 1 ? TOKEN : "renewed-token"),
      };
    });
    mockQuery(({ bearer }) => {
      bearerTokens.push(bearer);
      return bearer === `Bearer ${TOKEN}`
        ? expiredSession()
        : { statusCode: 200, data: queryResponse() };
    });
    expect(
      await new SalesforceConnector().testConnection({
        config: CONFIG,
        credentials: CREDS,
      }),
    ).toEqual({ success: true });
    expect(grants).toBe(2);
    expect(bearerTokens).toEqual([`Bearer ${TOKEN}`, "Bearer renewed-token"]);
  });

  test("stops retrying if Salesforce rejects a renewed session", async () => {
    let grants = 0;
    mockToken(() => {
      grants++;
      return { statusCode: 200, data: tokenResponse() };
    });
    mockQuery(expiredSession);
    const result = await new SalesforceConnector().testConnection({
      config: CONFIG,
      credentials: CREDS,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("rejected a renewed OAuth session");
    expect(grants).toBe(2);
  });

  test.each([
    "initial",
    "renewal",
  ])("does not expose secrets from %s authentication errors", async (stage) => {
    if (stage === "renewal") {
      agent
        .get(DOMAIN)
        .intercept({ path: "/services/oauth2/token", method: "POST" })
        .reply(200, tokenResponse(), {
          headers: { "content-type": "application/json" },
        });
    }
    mockToken(
      () => ({
        statusCode: 400,
        data: {
          error: "invalid_client",
          error_description: `Rejected ${CREDS.apiToken} ${TOKEN}`,
        },
      }),
      400,
    );
    mockQuery(expiredSession);
    const result = await new SalesforceConnector().testConnection({
      config: CONFIG,
      credentials: CREDS,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Salesforce OAuth authentication failed");
    const surfaced = JSON.stringify({
      result,
      logs: vi.mocked(logger.error).mock.calls,
    });
    expect(surfaced).not.toContain(CREDS.apiToken);
    expect(surfaced).not.toContain(TOKEN);
  });

  test("redacts secrets from downstream API errors and logs", async () => {
    mockToken(() => ({ statusCode: 200, data: tokenResponse() }));
    mockQuery(() => ({
      statusCode: 400,
      data: [
        {
          errorCode: "INVALID_FIELD",
          message: `Rejected ${CREDS.apiToken} ${TOKEN}`,
        },
      ],
    }));
    const result = await new SalesforceConnector().testConnection({
      config: CONFIG,
      credentials: CREDS,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("[REDACTED]");
    const surfaced = JSON.stringify({
      result,
      logs: vi.mocked(logger.error).mock.calls,
    });
    expect(surfaced).not.toContain(CREDS.apiToken);
    expect(surfaced).not.toContain(TOKEN);
  });

  test("accepts a Salesforce instance URL different from the My Domain auth endpoint", async () => {
    const instanceUrl = "https://na123.salesforce.com";
    mockToken(() => ({
      statusCode: 200,
      data: { ...tokenResponse(), instance_url: instanceUrl },
    }));
    mockQuery(() => ({ statusCode: 200, data: queryResponse() }), instanceUrl);
    expect(
      await new SalesforceConnector().testConnection({
        config: CONFIG,
        credentials: CREDS,
      }),
    ).toEqual({ success: true });
  });

  test.each([
    { ...tokenResponse(), access_token: "" },
    { ...tokenResponse(), instance_url: "https://attacker.test" },
  ])("rejects malformed or unsafe OAuth responses", async (data) => {
    mockToken(() => ({ statusCode: 200, data }));
    expect(
      (
        await new SalesforceConnector().testConnection({
          config: CONFIG,
          credentials: CREDS,
        })
      ).error,
    ).toContain("Salesforce OAuth authentication failed");
  });

  test("redacts API errors escaping permission group sync", async () => {
    mockToken(() => ({ statusCode: 200, data: tokenResponse() }));
    mockQuery(() => ({
      statusCode: 400,
      data: [
        {
          errorCode: "INVALID_FIELD",
          message: `Rejected ${CREDS.apiToken} ${TOKEN}`,
        },
      ],
    }));
    const groups = new SalesforceConnector().syncGroups({
      config: CONFIG,
      credentials: CREDS,
      cursor: null,
      readIngestedDocuments: async () => ({ documents: [], nextAfterId: null }),
    });
    await expect(groups.next()).rejects.toThrow(
      "Rejected [REDACTED] [REDACTED]",
    );
  });

  test.each([
    {},
    { ...CONFIG, clientId: undefined },
    { ...CONFIG, loginUrl: "https://login.salesforce.com" },
    { ...CONFIG, loginUrl: "https://test.salesforce.com" },
    { ...CONFIG, loginUrl: "http://example.my.salesforce.com" },
    { ...CONFIG, loginUrl: "https://example.my.salesforce.com.attacker.test" },
    { ...CONFIG, loginUrl: `${DOMAIN}/services/oauth2/token` },
    { ...CONFIG, loginUrl: `${DOMAIN}?secret=wrong` },
    { ...CONFIG, loginUrl: "https://user:password@example.my.salesforce.com" },
  ])("rejects invalid OAuth configuration before making an auth request: %j", async (config) => {
    expect(
      (
        await new SalesforceConnector().testConnection({
          config,
          credentials: {
            email: "legacy@example.com",
            apiToken: "old-password",
          },
        })
      ).success,
    ).toBe(false);
  });

  test("rejects missing credentials before making an auth request", async () => {
    const result = await new SalesforceConnector().testConnection({
      config: CONFIG,
      credentials: { apiToken: " " },
    });
    expect(result.error).toContain("Missing Salesforce OAuth consumer secret");
  });

  test.each([
    undefined,
    "soap_legacy",
  ])("preserves existing SOAP login for authMethod %s and warns about retirement", async (authMethod) => {
    const bodies: string[] = [];
    agent
      .get("https://login.salesforce.com")
      .intercept({
        path: /^\/services\/Soap\/u\/[\d.]+$/,
        method: "POST",
      })
      .reply(
        200,
        async (options) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of options.body as AsyncIterable<Uint8Array>)
            chunks.push(chunk);
          bodies.push(Buffer.concat(chunks).toString("utf8"));
          return `<Envelope><Body><loginResponse><result><serverUrl>${DOMAIN}/services/Soap/u/58.0/00D000000000001</serverUrl><sessionId>${TOKEN}</sessionId><userId>005000000000001</userId><organizationId>00D000000000001</organizationId></result></loginResponse></Body></Envelope>`;
        },
        { headers: { "content-type": "text/xml" } },
      )
      .persist();
    mockQuery(({ bearer }) => {
      expect(bearer).toBe(`Bearer ${TOKEN}`);
      return { statusCode: 200, data: queryResponse() };
    });
    const connector = new SalesforceConnector();
    const params = {
      config: { type: "salesforce", authMethod, objects: ["Account"] },
      credentials: {
        email: "legacy@example.com",
        apiToken: "old-password-token",
      },
    };
    expect(await connector.testConnection(params)).toEqual({ success: true });
    const batches = [];
    for await (const batch of connector.sync({ ...params, checkpoint: null }))
      batches.push(batch);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain("<username>legacy@example.com</username>");
      expect(body).toContain("<password>old-password-token</password>");
    }
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toContain(
      "Summer ’27",
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(
      "old-password-token",
    );
  });

  test("keeps a failed legacy login sanitized and explains migration", async () => {
    agent
      .get("https://login.salesforce.com")
      .intercept({ path: /^\/services\/Soap\/u\/[\d.]+$/, method: "POST" })
      .reply(401, "Rejected old-password-token");
    const result = await new SalesforceConnector().testConnection({
      config: { type: "salesforce" },
      credentials: {
        email: "legacy@example.com",
        apiToken: "old-password-token",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Salesforce legacy login failed");
    expect(result.error).toContain("Migrate to OAuth client credentials");
    expect(JSON.stringify(result)).not.toContain("old-password-token");
  });

  test("rejects missing legacy credentials before making an auth request", async () => {
    const result = await new SalesforceConnector().testConnection({
      config: { type: "salesforce" },
      credentials: CREDS,
    });
    expect(result.error).toContain(
      "Missing Salesforce username or password+security token",
    );
    expect(
      SalesforceConfigSchema.parse({ type: "salesforce" }).authMethod,
    ).toBeUndefined();
    expect(
      SalesforceConfigSchema.safeParse({ ...CONFIG, authMethod: "password" })
        .success,
    ).toBe(false);
    expect(
      SalesforceConfigSchema.safeParse({ ...CONFIG, clientId: " " }).success,
    ).toBe(false);
  });

  test.each([
    "develop",
    "scratch",
    "trailblaze",
    "demo",
    "free",
    "patch",
  ])("accepts documented %s My Domain partitions", async (partition) => {
    expect(
      await new SalesforceConnector().validateConfig({
        ...CONFIG,
        loginUrl: `https://example.${partition}.my.salesforce.com`,
      }),
    ).toEqual({ valid: true });
  });

  test("accepts a sandbox My Domain URL and normalizes its trailing slash", async () => {
    const config = SalesforceConfigSchema.parse({
      ...CONFIG,
      loginUrl: "example--test.sandbox.my.salesforce.com/",
    });
    expect(config.loginUrl).toBe(
      "https://example--test.sandbox.my.salesforce.com",
    );
    expect(await new SalesforceConnector().validateConfig(config)).toEqual({
      valid: true,
    });
  });
});
