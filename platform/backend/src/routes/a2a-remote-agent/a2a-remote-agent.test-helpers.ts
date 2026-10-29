import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// The dependency-free E2E fixture intentionally ships as plain JavaScript.
// @ts-expect-error -- no declaration file is needed outside these route tests.
import { createA2aFixtureServer } from "../../../../e2e-tests/fixtures/a2a-test-agent/server.mjs";

export type FixtureAuthMode = "none" | "bearer" | "api-key" | "either";

type FixtureRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
};

export function makeAgentCard(
  authMode: FixtureAuthMode = "none",
  overrides: Record<string, unknown> = {},
) {
  const security =
    authMode === "none"
      ? { securitySchemes: {}, securityRequirements: [] }
      : authMode === "bearer"
        ? {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
            securityRequirements: [{ bearerAuth: [] }],
          }
        : authMode === "api-key"
          ? {
              securitySchemes: {
                apiKeyAuth: {
                  type: "apiKey",
                  in: "header",
                  name: "X-API-Key",
                },
              },
              securityRequirements: [{ apiKeyAuth: [] }],
            }
          : {
              securitySchemes: {
                bearerAuth: { type: "http", scheme: "bearer" },
                apiKeyAuth: {
                  type: "apiKey",
                  in: "header",
                  name: "X-API-Key",
                },
              },
              securityRequirements: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
            };

  return {
    name: "Route Test Agent",
    description: "A deterministic outbound A2A route-test target.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: "http://127.0.0.1:9191/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    ...security,
    ...overrides,
  };
}

/** Serve one fixed Agent Card at the well-known path, whatever it advertises. */
export async function serveAgentCard(card: Record<string, unknown>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url !== "/.well-known/agent-card.json") {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(card));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startA2aDiscoveryFixture(
  authMode: FixtureAuthMode = "none",
  hostname = "127.0.0.1",
  basePath = "",
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: () => Promise<FixtureRequest[]>;
}> {
  const trimmedBasePath = basePath.replace(/^\/+|\/+$/g, "");
  const normalizedBasePath = trimmedBasePath ? `/${trimmedBasePath}` : "";
  const server = createA2aFixtureServer({
    authMode,
    basePath: normalizedBasePath,
  }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://${hostname}:${address.port}`;

  return {
    baseUrl: `${origin}${normalizedBasePath}`,
    requests: async () => {
      const response = await fetch(`${origin}/__fixture/requests`);
      const body = (await response.json()) as { requests: FixtureRequest[] };
      return body.requests;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
