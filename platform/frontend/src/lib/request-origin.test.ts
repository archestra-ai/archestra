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
