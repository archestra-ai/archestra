// @vitest-environment node
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { makeSkillDetail } from "@/mocks/data/skills";
import { buildChatgptPlugin } from "./chatgpt-plugin";

const params = {
  appName: "Example Platform",
  gatewayUrl: "https://gateway.example.test/v1/mcp/team",
};

describe("ChatGPT plugin archive", () => {
  it("downloads from an HTTP dashboard without browser Web Crypto", async () => {
    const expected = await buildChatgptPlugin({ ...params, skills: [] });
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "crypto",
    );
    try {
      vi.stubGlobal("crypto", undefined);
      const result = await buildChatgptPlugin({ ...params, skills: [] });
      expect(result.filename).toBe(expected.filename);
      expect(
        (await JSZip.loadAsync(result.bytes)).file("mcp.json"),
      ).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
      if (cryptoDescriptor)
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    }
  });

  it("packages OAuth MCP and complete portable skill files without account metadata", async () => {
    const skill = makeSkillDetail("example-skill");
    skill.files.push({
      ...skill.files[0],
      path: "assets/example.bin",
      encoding: "base64",
      content: "AAECAw==",
    });
    const result = await buildChatgptPlugin({ ...params, skills: [skill] });
    const zip = await JSZip.loadAsync(result.bytes);
    const manifest = JSON.parse(
      await requiredFile(zip, "plugin.json").async("string"),
    );
    expect(manifest.extensions["com.openai"].interface.displayName).toBe(
      params.appName,
    );
    expect(manifest.version).toMatch(/^1\.0\.\d+$/);
    const mcp = JSON.parse(await requiredFile(zip, "mcp.json").async("string"));
    expect(mcp.mcpServers.gateway.url).toBe(params.gatewayUrl);
    expect(mcp.mcpServers.gateway.extensions["com.openai"].auth).toEqual({
      type: "oauth",
      client: { mode: "dcr" },
    });
    const body = await requiredFile(zip, `skills/${skill.name}/SKILL.md`).async(
      "string",
    );
    expect(body).toBe(
      [
        "---",
        `name: ${JSON.stringify(skill.name)}`,
        `description: ${JSON.stringify(skill.description)}`,
        "---",
        "",
        "Do the thing, carefully.",
      ].join("\n"),
    );
    expect(
      await requiredFile(zip, `skills/${skill.name}/assets/example.bin`).async(
        "uint8array",
      ),
    ).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(
      await requiredFile(zip, `skills/${skill.name}/reference/fields.md`).async(
        "string",
      ),
    ).toBe(skill.files[0].content);
    expect(
      Object.keys(zip.files).some((name) =>
        /token|auth\.json|config\.toml/.test(name),
      ),
    ).toBe(false);
    expect(body).not.toContain(skill.organizationId);
    expect(result.skillCount).toBe(1);
  });

  it.each([
    { description: "", field: "description" },
    { description: "x".repeat(1025), field: "description" },
    { compatibility: "x".repeat(501), field: "compatibility" },
  ])("rejects a nonportable $field without changing the skill", async (fields) => {
    const { field, ...overrides } = fields;
    const skill = { ...makeSkillDetail("example"), ...overrides };
    const original = structuredClone(skill);
    await expect(
      buildChatgptPlugin({ ...params, skills: [skill] }),
    ).rejects.toThrow(new RegExp(`Skill ${skill.name}.*${field}`));
    expect(skill).toEqual(original);
  });

  it.each([
    { label: "absent", compatibility: null, description: "😀" },
    { label: "empty", compatibility: "", description: "😀".repeat(1024) },
    {
      label: "maximum length",
      compatibility: "😀".repeat(500),
      description: "😀".repeat(1024),
    },
  ])("preserves boundary-length fields with $label compatibility", async ({
    compatibility,
    description,
  }) => {
    const skill = {
      ...makeSkillDetail("example"),
      description,
      compatibility,
    };
    const result = await buildChatgptPlugin({ ...params, skills: [skill] });
    const zip = await JSZip.loadAsync(result.bytes);
    const body = await requiredFile(zip, `skills/${skill.name}/SKILL.md`).async(
      "string",
    );
    expect(body).toBe(
      [
        "---",
        `name: ${JSON.stringify(skill.name)}`,
        `description: ${JSON.stringify(skill.description)}`,
        ...(compatibility
          ? [`compatibility: ${JSON.stringify(compatibility)}`]
          : []),
        "---",
        "",
        skill.content,
      ].join("\n"),
    );
  });

  it("keeps long deployment names valid and rejects file/directory collisions", async () => {
    const valid = await buildChatgptPlugin({
      ...params,
      appName: `${"a".repeat(39)} b`,
      skills: [],
    });
    const zip = await JSZip.loadAsync(valid.bytes);
    const manifest = JSON.parse(
      await requiredFile(zip, "plugin.json").async("string"),
    );
    expect(manifest.name).not.toContain("--");
    const skill = makeSkillDetail("example");
    skill.files.push({ ...skill.files[0], path: "reference" });
    await expect(
      buildChatgptPlugin({ ...params, skills: [skill] }),
    ).rejects.toThrow("resource path");
  });

  it("keeps different gateway imports distinct without changing an existing gateway's identity", async () => {
    const first = await buildChatgptPlugin({ ...params, skills: [] });
    const repeated = await buildChatgptPlugin({ ...params, skills: [] });
    const other = await buildChatgptPlugin({
      ...params,
      gatewayUrl: "https://other.example.test/v1/mcp/team",
      skills: [],
    });
    expect(first.filename).toBe(repeated.filename);
    expect(other.filename).not.toBe(first.filename);
  });

  it("reports skills that require platform activation instead of shipping broken templates", async () => {
    const skill = makeSkillDetail("example");
    const result = await buildChatgptPlugin({
      ...params,
      skills: [{ ...skill, templated: true }],
    });
    expect(result.omitted).toEqual([skill.name]);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(
      Object.keys(zip.files).some((name) => name.startsWith("skills/")),
    ).toBe(false);
  });

  it.each([
    "../outside",
    "/absolute",
    "a/../../outside",
    "a\\outside",
    "SKILL.md",
    "SKILL.md/notes.txt",
    "reference/../outside",
  ])("rejects unsafe resource path %s", async (path) => {
    const skill = makeSkillDetail("example");
    skill.files = [{ ...skill.files[0], path }];
    await expect(
      buildChatgptPlugin({ ...params, skills: [skill] }),
    ).rejects.toThrow("resource path");
  });

  it.each([
    "http://localhost:9000/v1/mcp/team",
    "https://user:secret@example.test/mcp",
    "https://example.test/mcp?token=secret",
    "https://example.test/mcp#secret",
  ])("rejects insecure or credential-bearing URL %s", async (gatewayUrl) => {
    await expect(
      buildChatgptPlugin({ ...params, gatewayUrl, skills: [] }),
    ).rejects.toThrow("HTTPS gateway URL");
  });
});

function requiredFile(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) throw new Error(`Missing archive file: ${path}`);
  return file;
}
