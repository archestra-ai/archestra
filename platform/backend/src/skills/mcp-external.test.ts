import { createHash } from "node:crypto";
import { MCP_SKILLS_EXTENSION_ID } from "@archestra/shared";
import { vi } from "vitest";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import { McpCatalogSkillModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { readExternalMcpSkill, refreshMcpSkillMetadata } from "./mcp-external";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ROOT = "skill://example/release";
const MANIFEST_URI = `${ROOT}/SKILL.md`;

describe("external MCP Skills", () => {
  let originalEnabled: boolean;

  beforeEach(() => {
    originalEnabled = config.mcpGateway.skillsEnabled;
    config.mcpGateway.skillsEnabled = true;
  });

  afterEach(() => {
    config.mcpGateway.skillsEnabled = originalEnabled;
    vi.restoreAllMocks();
  });

  test("skills/list metadata is reconciled without reading resource bytes", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const first = skillEntry({ name: "release", body: "# v1" });
    const second = skillEntry({
      root: "skill://example/triage",
      name: "triage",
      body: "# triage",
    });
    const client = stubSession({ listed: [first.entry, second.entry] });

    await refreshMcpSkillMetadata({
      catalogId: catalog.id,
      mcpServerId: SERVER_ID,
    });

    expect(client.readResource).not.toHaveBeenCalled();
    expect(
      (await McpCatalogSkillModel.findByCatalogIds([catalog.id])).map(
        (skill) => skill.name,
      ),
    ).toEqual(["release", "triage"]);

    stubSession({ listed: [second.entry] });
    await refreshMcpSkillMetadata({
      catalogId: catalog.id,
      mcpServerId: SERVER_ID,
    });
    expect(
      (await McpCatalogSkillModel.findByCatalogIds([catalog.id])).map(
        (skill) => skill.name,
      ),
    ).toEqual(["triage"]);
  });

  test("content is fetched from the source live and digest-verified", async () => {
    const current = skillEntry({ name: "release", body: "# current" });
    stubSession({
      listed: [current.entry],
      current: current.entry,
      resources: current.bytes,
    });

    const result = await readExternalMcpSkill({
      mcpServerId: SERVER_ID,
      uri: MANIFEST_URI,
    });

    expect(result.name).toBe("release");
    expect(result.content.trim()).toBe("# current");
    expect(result.files).toEqual([]);
  });

  test("a slower older listing cannot overwrite newer metadata", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    let releaseOlder: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    let olderEntered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      olderEntered = resolve;
    });
    let call = 0;
    vi.spyOn(mcpClient, "withSkillsSession").mockImplementation(
      async ({ run }) => {
        const thisCall = ++call;
        if (thisCall === 1) {
          olderEntered();
          await gate;
        }
        const name = thisCall === 1 ? "older" : "newer";
        return run(
          {
            request: vi.fn(async () => ({
              skills: [
                {
                  uri: MANIFEST_URI,
                  frontmatter: { name, description: `${name}.` },
                  resources: [],
                },
              ],
            })),
          } as never,
          {
            serverExtensions: () => ({ [MCP_SKILLS_EXTENSION_ID]: {} }),
          },
        );
      },
    );

    const older = refreshMcpSkillMetadata({
      catalogId: catalog.id,
      mcpServerId: SERVER_ID,
    });
    await started;
    await refreshMcpSkillMetadata({
      catalogId: catalog.id,
      mcpServerId: SERVER_ID,
    });
    releaseOlder();
    await older;

    expect(
      (await McpCatalogSkillModel.findByCatalogIds([catalog.id])).map(
        (skill) => skill.name,
      ),
    ).toEqual(["newer"]);
  });

  test("a source byte that does not match its digest is rejected", async () => {
    const current = skillEntry({ name: "release", body: "# promised" });
    stubSession({
      listed: [current.entry],
      current: current.entry,
      resources: new Map([[MANIFEST_URI, "# different bytes"]]),
    });

    await expect(
      readExternalMcpSkill({
        mcpServerId: SERVER_ID,
        uri: MANIFEST_URI,
      }),
    ).rejects.toThrow(/digest verification/);
  });
});

function stubSession(params: {
  listed: Entry[];
  current?: Entry;
  resources?: Map<string, string>;
}) {
  const request = vi.fn(async (input: { method: string }) => {
    if (input.method === "skills/list") return { skills: params.listed };
    if (input.method === "skills/get") return { skill: params.current };
    throw new Error(`Unexpected method ${input.method}`);
  });
  const readResource = vi.fn(async ({ uri }: { uri: string }) => ({
    contents: [{ uri, text: params.resources?.get(uri) ?? "" }],
  }));
  vi.spyOn(mcpClient, "withSkillsSession").mockImplementation(async ({ run }) =>
    run({ request, readResource } as never, {
      serverExtensions: () => ({ [MCP_SKILLS_EXTENSION_ID]: {} }),
    }),
  );
  return { request, readResource };
}

interface Entry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string }>;
}

function skillEntry(params: { root?: string; name: string; body: string }) {
  const root = params.root ?? ROOT;
  const uri = `${root}/SKILL.md`;
  const manifest = `---\nname: ${params.name}\ndescription: Test skill.\n---\n${params.body}`;
  const digest = `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  return {
    entry: {
      uri,
      frontmatter: { name: params.name, description: "Test skill." },
      resources: [{ uri, digest }],
    } satisfies Entry,
    bytes: new Map([[uri, manifest]]),
  };
}
