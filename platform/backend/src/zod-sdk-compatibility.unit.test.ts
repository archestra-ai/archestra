import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { Activity } from "@microsoft/agents-activity";
import { ConfluenceClient } from "confluence.js";
import { ConfigSchema } from "confluence.js/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

test.each([
  "@microsoft/agents-activity",
  "@microsoft/agents-hosting",
  "confluence.js",
])("%s rejects oversized containers before walking their contents", (name) => {
  const load = createRequire(import.meta.resolve(name));
  const { z } = load("zod") as typeof import("zod");
  let visited = 0;
  const value = z.string().superRefine(() => {
    visited++;
  });
  const cases = [
    { schema: z.array(value).max(1), input: ["a", "b"] },
    { schema: z.set(value).max(1), input: new Set(["a", "b"]) },
  ];
  for (const { schema, input } of cases) {
    visited = 0;
    const result = schema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Oversized container was accepted");
    expect(visited).toBe(0);
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: "too_big" }),
    ]);
  }
});

describe("Teams activity validation", () => {
  test("keeps semantic-action entities and extension fields", () => {
    const activity = Activity.fromObject({
      type: "message",
      text: "hello",
      channelId: "msteams",
      extensionField: "preserved",
      entities: [{ type: "mention", mentioned: { id: "test-agent" } }],
      semanticAction: {
        id: "test-action",
        state: "start",
        entities: { target: { type: "test-entity" } },
      },
    });
    expect(activity).toMatchObject({
      extensionField: "preserved",
      entities: [{ type: "mention", mentioned: { id: "test-agent" } }],
      semanticAction: { entities: { target: { type: "test-entity" } } },
    });
  });

  test("rejects malformed activities and semantic-action values", () => {
    expect(() => Activity.fromObject({ type: "" })).toThrow();
    expect(() =>
      Activity.fromObject({
        type: "message",
        semanticAction: {
          id: "test-action",
          state: "start",
          entities: { target: "not-an-entity" },
        },
      }),
    ).toThrow();
  });
});

describe("Confluence client validation and transport", () => {
  let server: Server;
  let host: string;
  const requests: {
    url: string | undefined;
    authorization: string | undefined;
  }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/error")) {
        response.statusCode = 503;
        response.end(JSON.stringify({ message: "test-upstream-error" }));
      } else {
        response.end(JSON.stringify({ id: "42", title: "Test page" }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  test("loads the CommonJS client with the same URL validation", () => {
    const load = createRequire(import.meta.url);
    const { ConfluenceClient: CommonJsClient } = load(
      "confluence.js",
    ) as typeof import("confluence.js");
    expect(() => new CommonJsClient({ host })).not.toThrow();
    expect(() => new CommonJsClient({ host: "invalid-url" })).toThrow(
      "Couldn't parse the host URL",
    );
  });

  test("preserves authenticated requests and response/error middleware", async () => {
    const responses: unknown[] = [];
    const errors: unknown[] = [];
    const client = new ConfluenceClient({
      host,
      baseRequestConfig: { proxy: false },
      authentication: {
        basic: { email: "sdk-test@example.com", apiToken: "test-token" },
      },
      middlewares: {
        onResponse: (value) => {
          responses.push(value);
        },
        onError: (value) => {
          errors.push(value);
        },
      },
    });
    const page = await client.content.getContentById({ id: "42" });
    expect(page).toMatchObject({ id: "42", title: "Test page" });
    expect(requests.at(-1)).toEqual({
      url: "/wiki/rest/api/content/42",
      authorization:
        "Basic " +
        Buffer.from("sdk-test@example.com:test-token").toString("base64"),
    });
    expect(responses).toEqual([page]);
    await expect(
      client.content.getContentById({ id: "error" }),
    ).rejects.toEqual({
      message: "test-upstream-error",
    });
    expect(errors).toEqual([{ message: "test-upstream-error" }]);
  });

  test("retains URL, credential and middleware validation", () => {
    expect(() => new ConfluenceClient({ host: "invalid-url" })).toThrow(
      "Couldn't parse the host URL",
    );
    expect(
      ConfigSchema.safeParse({
        host,
        authentication: {
          basic: { email: "sdk-test@example.com", apiToken: "" },
        },
      }).success,
    ).toBe(false);
    expect(
      ConfigSchema.safeParse({ host, middlewares: { onResponse: 42 } }).success,
    ).toBe(false);
  });

  test("retains the void-return contract for middleware", async () => {
    const client = new ConfluenceClient({
      host,
      baseRequestConfig: { proxy: false },
      middlewares: { onResponse: () => "invalid-return-value" },
    });
    await expect(client.content.getContentById({ id: "42" })).rejects.toThrow();
  });
});
