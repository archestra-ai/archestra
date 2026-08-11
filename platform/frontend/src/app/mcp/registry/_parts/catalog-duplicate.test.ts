import { describe, expect, it } from "vitest";
import {
  deriveCatalogSearchTerm,
  findCatalogDuplicate,
  findExternalCatalogMatch,
} from "./catalog-duplicate";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { parseMcpConfigText } from "./mcp-config-import";

type Items = Parameters<typeof findCatalogDuplicate>[1];
type Manifests = Parameters<typeof findExternalCatalogMatch>[1];

const ITEMS = [
  {
    id: "id-linear",
    name: "linear",
    serverType: "remote",
    serverUrl: "https://mcp.linear.app/mcp",
  },
  {
    id: "id-context7",
    name: "Context7",
    serverType: "local",
    localConfig: { command: "npx", arguments: ["-y", "@upstash/context7-mcp"] },
  },
  {
    id: "id-imaged",
    name: "imaged",
    serverType: "local",
    localConfig: { dockerImage: "ghcr.io/acme/server:1" },
  },
] as unknown as NonNullable<Items>;

function values(config: unknown, name = ""): McpCatalogFormValues {
  const parsed = parseMcpConfigText(JSON.stringify(config));
  if (parsed.status !== "servers") throw new Error("fixture did not parse");
  return { ...parsed.servers[0].values, name } as McpCatalogFormValues;
}

describe("findCatalogDuplicate", () => {
  it("matches a remote by URL, ignoring case and trailing slash", () => {
    const match = findCatalogDuplicate(
      values({ type: "http", url: "https://MCP.linear.app/mcp/" }, "other"),
      ITEMS,
    );
    expect(match?.item.id).toBe("id-linear");
    expect(match?.reason).toBe("same server URL");
  });

  it("matches a local by command line and prefers it over a name match", () => {
    const match = findCatalogDuplicate(
      values(
        { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        "linear",
      ),
      ITEMS,
    );
    expect(match?.item.id).toBe("id-context7");
    expect(match?.reason).toBe("same command");
  });

  it("matches by normalized name as the weakest signal", () => {
    const match = findCatalogDuplicate(
      values({ command: "node", args: ["server.js"] }, "context-7"),
      ITEMS,
    );
    expect(match?.item.id).toBe("id-context7");
    expect(match?.reason).toBe("same name");
  });

  it("matches a docker image", () => {
    const match = findCatalogDuplicate(
      values({
        command: "docker",
        args: ["run", "-i", "ghcr.io/acme/server:1"],
      }),
      ITEMS,
    );
    expect(match?.item.id).toBe("id-imaged");
    expect(match?.reason).toBe("same Docker image");
  });

  it("returns null with no attributable data or no items", () => {
    const empty = values({ command: "x" });
    empty.localConfig = { ...empty.localConfig, command: "" } as never;
    expect(findCatalogDuplicate(empty, ITEMS)).toBeNull();
    expect(
      findCatalogDuplicate(values({ command: "npx" }), undefined),
    ).toBeNull();
  });
});

const MANIFESTS = [
  {
    name: "upstash__context7",
    display_name: "Context7",
    description: "Up-to-date code documentation for LLMs",
    icon: "https://example.com/context7.png",
    server: {
      type: "local",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
    archestra_config: {
      client_config_permutations: {
        docker: {
          command: "docker",
          args: ["run", "-i", "ghcr.io/upstash/context7:1"],
          docker_image: "ghcr.io/upstash/context7:1",
        },
      },
      oauth: { provider: null, required: false },
      works_in_archestra: true,
    },
  },
  {
    name: "linear__linear",
    display_name: "Linear",
    description: "Issue tracking",
    server: {
      type: "remote",
      url: "https://mcp.linear.app/mcp",
      docs_url: null,
    },
  },
] as unknown as NonNullable<Manifests>;

describe("findExternalCatalogMatch", () => {
  it("matches a local template by command line", () => {
    const match = findExternalCatalogMatch(
      values({ command: "npx", args: ["-y", "@upstash/context7-mcp"] }),
      MANIFESTS,
    );
    expect(match?.manifest.display_name).toBe("Context7");
    expect(match?.reason).toBe("same command");
  });

  it("matches through a client-config permutation's docker image", () => {
    const match = findExternalCatalogMatch(
      values({
        command: "docker",
        args: ["run", "-i", "ghcr.io/upstash/context7:1"],
      }),
      MANIFESTS,
    );
    expect(match?.manifest.display_name).toBe("Context7");
    expect(match?.reason).toBe("same Docker image");
  });

  it("matches a remote template by URL", () => {
    const match = findExternalCatalogMatch(
      values({ type: "http", url: "https://MCP.linear.app/mcp/" }),
      MANIFESTS,
    );
    expect(match?.manifest.display_name).toBe("Linear");
    expect(match?.reason).toBe("same server URL");
  });

  it("NEVER matches on name alone — silent writes need strong identity", () => {
    const match = findExternalCatalogMatch(
      values({ command: "node", args: ["server.js"] }, "Context7"),
      MANIFESTS,
    );
    expect(match).toBeNull();
  });
});

describe("deriveCatalogSearchTerm", () => {
  it("reduces a runner's package token to its core name", () => {
    expect(
      deriveCatalogSearchTerm(
        values({ command: "npx", args: ["-y", "@upstash/context7-mcp"] }),
      ),
    ).toBe("context7");
    expect(
      deriveCatalogSearchTerm(
        values({ command: "uvx", args: ["mcp-server-fetch"] }),
      ),
    ).toBe("fetch");
  });

  it("derives from a docker image repository", () => {
    expect(
      deriveCatalogSearchTerm(
        values({
          command: "docker",
          args: ["run", "-i", "ghcr.io/github/github-mcp-server:latest"],
        }),
      ),
    ).toBe("github");
  });

  it("derives from a remote URL's hostname, dropping mcp/www labels and the TLD", () => {
    expect(
      deriveCatalogSearchTerm(
        values({ type: "http", url: "https://mcp.context7.com/mcp" }),
      ),
    ).toBe("context7");
  });

  it("returns null for arbitrary commands and empty forms", () => {
    expect(
      deriveCatalogSearchTerm(values({ command: "node", args: ["server.js"] })),
    ).toBeNull();
  });
});
