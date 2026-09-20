import { expect, test } from "vitest";
import { GET as connect } from "@/app/connect.md/route";
import { GET as discovery } from "@/app/llms.txt/route";

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

test("the connection guide automates both OpenCode browser approvals without duplicate installers", async () => {
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
  expect(body).toContain("opencode mcp auth SERVER_NAME");
  expect(body).toContain("this second URL is the");
  expect(body).toContain("not another connection approval");
  expect(body).not.toContain("so do the sign-in from here");
});
