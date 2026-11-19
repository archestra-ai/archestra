import { createServer } from "node:http";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import { GROK_NATIVE_TRANSPORT } from "./grok-native-transport";

test("native transport retains catalog identity and reasoning options, protects streaming and cannot proxy arbitrary native endpoints", async () => {
  const calls: {
    url: string;
    headers: typeof incomingHeaders;
    body: string;
  }[] = [];
  const incomingHeaders: Record<string, string | string[] | undefined> = {};
  let rejectAuth = false;
  let redirect = false;
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url ?? "", headers: request.headers, body });
    if (rejectAuth) {
      response.writeHead(401).end("synthetic-private-error");
    } else if (redirect) {
      response.writeHead(307, { location: "/unguarded" }).end();
    } else if (request.url?.endsWith("/native/models")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "native-reasoner",
              model: "native-wire",
              name: "Native Reasoner",
              api_backend: "responses",
              context_window: 200000,
              base_url: "https://unprotected.invalid/v1",
              apiBaseUrl: "https://unprotected.invalid/v1",
              apiKey: "synthetic-catalog-key",
              extraHeaders: { authorization: "synthetic-catalog-key" },
              reasoningEfforts: [
                { value: "high", label: "High", default: true },
              ],
              variants: [{ effort: "high", model_id: "native-high" }],
              _meta: { supportedInApi: false },
            },
            { id: "unsupported", api_backend: "messages" },
          ],
        }),
      );
    } else if (request.url?.endsWith("/native/settings")) {
      response.end(
        '{"default_model":"native-reasoner","session_summary_model":"native-reasoner","accept_request_encodings":["zstd","gzip"]}',
      );
    } else if (request.url?.endsWith("/native/user")) {
      response.end(
        '{"userId":"synthetic-user","codingDataRetentionOptOut":true}',
      );
    } else if (request.url?.endsWith("/native/privacy/coding-data-retention")) {
      response.end(body);
    } else {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "x-archestra-session": "synthetic-receipt",
        "set-cookie": "synthetic=private",
      });
      response.end("data: synthetic-stream\n\n");
    }
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1/xai`;
  const transport = (await runInNewContext(
    `${GROK_NATIVE_TRANSPORT}\nnew GrokNativeTransport(connection).start()`,
    {
      connection: {
        url,
        headers: { "x-archestra-virtual-key": "synthetic-attribution" },
      },
      require: createRequire(import.meta.url),
      URL,
      Headers,
      Response,
      Buffer,
      fetch,
      AbortSignal,
    },
  )) as { base: string; close(): Promise<void> };
  const headers = {
    authorization: "Bearer synthetic-native",
    "x-userid": "synthetic-user",
    "x-grok-session-id": "synthetic-session",
    cookie: "must-not-forward",
  };
  try {
    const settings = await fetch(`${transport.base}/settings`, { headers });
    expect(await settings.json()).toEqual({
      default_model: "native-reasoner",
      session_summary_model: "native-reasoner",
      accept_request_encodings: [],
    });
    const catalog = await fetch(`${transport.base}/models`, { headers });
    const value = await catalog.json();
    expect(value.data).toEqual([
      {
        id: "native-reasoner",
        model: "native-wire",
        name: "Native Reasoner",
        api_backend: "responses",
        context_window: 200000,
        base_url: transport.base,
        baseUrl: transport.base,
        reasoningEfforts: [{ value: "high", label: "High", default: true }],
        variants: [{ effort: "high", model_id: "native-high" }],
        _meta: { supportedInApi: false },
      },
    ]);
    const body = '{"model":"native-high","input":"synthetic","stream":true}';
    const inference = await fetch(`${transport.base}/responses`, {
      method: "POST",
      headers,
      body,
    });
    expect(await inference.text()).toBe("data: synthetic-stream\n\n");
    expect(inference.headers.get("x-archestra-session")).toBe(
      "synthetic-receipt",
    );
    expect(inference.headers.get("set-cookie")).toBeNull();
    expect(calls.at(-1)).toMatchObject({
      url: "/v1/xai/responses",
      body,
      headers: {
        authorization: "Bearer synthetic-native",
        "x-userid": "synthetic-user",
        "x-grok-session-id": "synthetic-session",
        "x-archestra-virtual-key": "synthetic-attribution",
        "x-archestra-grok-credential-mode": "native-session",
      },
    });
    expect(calls.every((call) => !call.headers.cookie)).toBe(true);
    const count = calls.length;
    for (const target of [
      "/settings?upstream=other",
      "/responses/compact",
      "/user",
      "/models/../../responses",
      "",
    ]) {
      expect((await fetch(transport.base + target, { headers })).status).toBe(
        403,
      );
    }
    expect(
      (
        await fetch(
          transport.base.replace(/\/[a-f0-9]{48}$/, "/wrong") + "/responses",
          { method: "POST", headers, body },
        )
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(count);
    for (const desired of [true, false]) {
      const privacy = await fetch(
        `${transport.base}/privacy/coding-data-retention`,
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ codingDataRetentionOptOut: desired }),
        },
      );
      expect(privacy.status).toBe(200);
      expect(await privacy.json()).toEqual({
        codingDataRetentionOptOut: desired,
      });
      expect(calls.at(-1)?.url).toBe(
        "/v1/xai/native/privacy/coding-data-retention",
      );
    }
    const privacyCount = calls.length;
    for (const body of [
      "{}",
      '{"codingDataRetentionOptOut":"true"}',
      '{"codingDataRetentionOptOut":true,"model":"inference"}',
    ]) {
      expect(
        (
          await fetch(`${transport.base}/privacy/coding-data-retention`, {
            method: "PUT",
            headers: { ...headers, "content-type": "application/json" },
            body,
          })
        ).status,
      ).toBe(400);
    }
    expect(calls).toHaveLength(privacyCount);
    rejectAuth = true;
    const rejected = await fetch(`${transport.base}/models`, { headers });
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain("synthetic-private-error");
    rejectAuth = false;
    redirect = true;
    expect(
      (
        await fetch(`${transport.base}/responses`, {
          method: "POST",
          headers,
          body,
        })
      ).status,
    ).toBe(502);
    expect(calls.some((call) => call.url === "/unguarded")).toBe(false);
    await transport.close();
    await expect(
      fetch(`${transport.base}/models`, { headers }),
    ).rejects.toThrow();
  } finally {
    await transport.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
