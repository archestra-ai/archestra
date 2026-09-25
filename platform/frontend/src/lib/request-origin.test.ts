import { afterEach, beforeEach, expect, test } from "vitest";
import { GET as connect } from "@/app/connect.md/route";
import { GET as discovery } from "@/app/llms.txt/route";

const CONFIG_KEYS = [
  "ARCHESTRA_FRONTEND_URL",
  "ARCHESTRA_API_BASE_URL",
  "NEXT_PUBLIC_ARCHESTRA_API_BASE_URL",
] as const;

let originalConfig: Partial<Record<(typeof CONFIG_KEYS)[number], string>> = {};

// These cases assert the scheme, so a configured public URL leaking in from the
// developer's own environment would decide the result instead of the case.
beforeEach(() => {
  originalConfig = {};
  for (const key of CONFIG_KEYS) {
    originalConfig[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CONFIG_KEYS) {
    const value = originalConfig[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function originsIn(body: string): Set<string> {
  const urls = [...body.matchAll(/https?:\/\/[^\s)]+/g)].map(
    (match) => new URL(match[0].replace(/\.$/, "")),
  );
  expect(urls.length).toBeGreaterThan(0);
  return new Set(urls.map((url) => url.origin));
}

test.each([
  { headers: {}, origin: "http://localhost:3005" },
  {
    headers: { host: "app.example.com", "x-forwarded-proto": "https" },
    origin: "https://app.example.com",
  },
  {
    headers: {
      host: "localhost:3005",
      "x-forwarded-host": "connect.example.com",
      "x-forwarded-proto": "https",
    },
    origin: "https://connect.example.com",
  },
  {
    headers: { "x-forwarded-host": "user@untrusted.example" },
    origin: "http://localhost:3005",
  },
  {
    headers: { "x-forwarded-host": "untrusted.example/instructions" },
    origin: "http://localhost:3005",
  },
])("connection documents link to the external origin: $origin ($headers)", async ({
  headers,
  origin,
}) => {
  for (const route of [connect, discovery]) {
    const response = route(
      new Request("http://localhost:3005/connect.md", {
        headers: headers as Record<string, string>,
      }),
    );
    const body = await response.text();
    const urls = [...body.matchAll(/https?:\/\/[^\s)]+/g)].map(
      (match) => new URL(match[0].replace(/\.$/, "")),
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls.map((url) => url.origin))).toEqual(new Set([origin]));
  }
});

// The regression these cases exist for: a layer-4 proxy route cannot send
// X-Forwarded-Proto, Next.js always binds plain http, and the connection
// documents then hand the reader http URLs for an https-only deployment.
test.each([
  {
    name: "ARCHESTRA_FRONTEND_URL",
    env: { ARCHESTRA_FRONTEND_URL: "https://connect.example.com" },
  },
  {
    name: "ARCHESTRA_API_BASE_URL, comma-separated",
    env: {
      ARCHESTRA_API_BASE_URL:
        "http://archestra.default.svc:9000,https://connect.example.com",
    },
  },
  {
    name: "NEXT_PUBLIC_ARCHESTRA_API_BASE_URL",
    env: { NEXT_PUBLIC_ARCHESTRA_API_BASE_URL: "https://connect.example.com" },
  },
])("keeps https for a host configured over https with no forwarded proto ($name)", async ({
  env,
}) => {
  Object.assign(process.env, env);

  for (const route of [connect, discovery]) {
    const body = await route(
      new Request("http://localhost:3005/connect.md", {
        headers: { host: "connect.example.com" },
      }),
    ).text();
    expect(originsIn(body)).toEqual(new Set(["https://connect.example.com"]));
  }
});

test("keeps http for a host that is in no configured public URL", async () => {
  process.env.ARCHESTRA_FRONTEND_URL = "https://connect.example.com";

  const body = await connect(
    new Request("http://localhost:3005/connect.md", {
      headers: { host: "other.example.com" },
    }),
  ).text();

  expect(originsIn(body)).toEqual(new Set(["http://other.example.com"]));
});

test("does not upgrade a host configured over http", async () => {
  process.env.ARCHESTRA_FRONTEND_URL = "http://connect.example.com";

  const body = await connect(
    new Request("http://localhost:3005/connect.md", {
      headers: { host: "connect.example.com" },
    }),
  ).text();

  expect(originsIn(body)).toEqual(new Set(["http://connect.example.com"]));
});

// A rejected forwarded host must not borrow the configured scheme either: the
// origin falls back to the bind address, which is not a configured host.
test("does not upgrade the fallback after rejecting a forwarded host", async () => {
  process.env.ARCHESTRA_FRONTEND_URL = "https://connect.example.com";

  const body = await connect(
    new Request("http://localhost:3005/connect.md", {
      headers: { "x-forwarded-host": "untrusted.example/instructions" },
    }),
  ).text();

  expect(originsIn(body)).toEqual(new Set(["http://localhost:3005"]));
});

test("the connection guide keeps installer source out of the conversation", async () => {
  const response = connect(
    new Request("http://localhost:3005/connect.md", {
      headers: { host: "localhost:3005" },
    }),
  );
  const body = await response.text();

  expect(body).toContain("curl --fail --silent --show-error");
  expect(body).toContain("Invoke-WebRequest");
  expect(body).toContain("summarize the result without pasting");
  expect(body).toContain(
    "stop instead of replacing the flow with manual API calls",
  );
});

test("the connection guide skips unnecessary OpenCode OAuth and keeps needed approval visible", async () => {
  const response = connect(
    new Request("http://localhost:3005/connect.md", {
      headers: { host: "localhost:3005" },
    }),
  );
  const body = await response.text();

  expect(body).toContain("run the installer here with a timeout of 600000 ms");
  expect(body).toContain(
    "not start a second installer while the first request is pending",
  );
  expect(body).toContain("run opencode mcp list first");
  expect(body).toContain("skip authentication; do not re-authenticate");
  expect(body).toContain("CI=true opencode mcp auth SERVER_NAME");
  expect(body).toContain("If no URL appears within 60 seconds, interrupt");
  expect(body).toContain("opencode mcp auth SERVER_NAME");
  expect(body).toContain("this URL is the gateway's native MCP OAuth consent");
  expect(body).toContain("not another connection approval");
  expect(body).not.toContain("so do the sign-in from here");
});
