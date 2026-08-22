import { createHash } from "node:crypto";
import { MCP_SKILLS_EXTENSION_ID } from "@archestra/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import type { DirectServerSession } from "@/clients/mcp-server-extensions";
import config from "@/config";
import logger from "@/logging";
import { McpCatalogSkillModel } from "@/models";
import type { ResolvedEnterpriseTransportCredential } from "@/services/identity-providers/enterprise-managed/broker";
import {
  MAX_FILES_PER_SKILL,
  MAX_SKILL_FILE_BYTES,
} from "@/skills/github-import";
import { deriveSkillFileKind, parseSkillManifest } from "@/skills/parser";
import {
  ApiError,
  type McpSkillMetadataInput,
  type McpSkillResource,
  type ToolOwner,
} from "@/types";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 100;
const MAX_SKILLS_PER_PAGE = 1_000;
const MAX_CATALOG_SKILLS = 5_000;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_TOTAL_SKILL_BYTES = 50 * 1024 * 1024;

const ResourceSchema = z.object({
  uri: z.string().max(2_048),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/i),
});
const EntrySchema = z
  .object({
    uri: z.string().max(2_048),
    frontmatter: z.record(z.string(), z.unknown()).default({}),
    resources: z
      .array(ResourceSchema)
      .max(MAX_FILES_PER_SKILL + 1)
      .nullable()
      .optional(),
  })
  .refine(
    (entry) =>
      Buffer.byteLength(JSON.stringify(entry.frontmatter)) <=
      MAX_FRONTMATTER_BYTES,
    "MCP Skill frontmatter exceeds the metadata limit",
  );
const ListResultSchema = z.object({
  skills: z.array(EntrySchema).max(MAX_SKILLS_PER_PAGE),
  nextCursor: z.string().optional(),
});
const GetResultSchema = z.object({ skill: EntrySchema });

async function syncMcpCatalogSkillMetadata(params: {
  catalogId: string;
  mcpServerId: string;
  enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
  owner?: ToolOwner;
  tokenAuth?: TokenAuthContext;
}): Promise<void> {
  if (!config.mcpGateway.skillsEnabled) return;
  const generation = await McpCatalogSkillModel.beginRefresh(params.catalogId);
  if (generation === null) return;
  const skills = await mcpClient.withSkillsSession({
    mcpServerId: params.mcpServerId,
    enterpriseTransportCredential: params.enterpriseTransportCredential,
    owner: params.owner,
    tokenAuth: params.tokenAuth,
    run: async (client, session) => {
      if (!declaresSkills(session)) return [];
      return listSkills(client);
    },
  });
  await McpCatalogSkillModel.syncCatalog({
    catalogId: params.catalogId,
    generation,
    skills: skills.map(toMetadata),
  });
}

/** Best-effort companion to tool sync: retain the previous listing on error. */
export async function refreshMcpSkillMetadata(params: {
  catalogId: string;
  mcpServerId: string;
  enterpriseTransportCredential?: ResolvedEnterpriseTransportCredential;
  owner?: ToolOwner;
  tokenAuth?: TokenAuthContext;
}): Promise<void> {
  try {
    await syncMcpCatalogSkillMetadata(params);
  } catch (error) {
    logger.warn(
      {
        catalogId: params.catalogId,
        mcpServerId: params.mcpServerId,
        error,
      },
      "MCP Skills metadata refresh failed; retaining the previous listing",
    );
  }
}

export async function readExternalMcpSkill(params: {
  mcpServerId: string;
  uri: string;
  owner?: ToolOwner;
  tokenAuth?: TokenAuthContext;
}): Promise<{
  uri: string;
  name: string;
  description: string;
  content: string;
  files: Array<{
    path: string;
    content: string;
    encoding: "utf8" | "base64";
    kind: ReturnType<typeof deriveSkillFileKind>;
  }>;
}> {
  if (!config.mcpGateway.skillsEnabled) {
    throw new ApiError(404, "Skills over MCP is not enabled");
  }
  return mcpClient.withSkillsSession({
    mcpServerId: params.mcpServerId,
    owner: params.owner,
    tokenAuth: params.tokenAuth,
    run: async (client, session) => {
      if (!declaresSkills(session)) {
        throw new ApiError(404, "The MCP server no longer serves skills");
      }
      const result = await client.request(
        { method: "skills/get", params: { uri: params.uri } },
        GetResultSchema,
        { timeout: REQUEST_TIMEOUT_MS },
      );
      if (result.skill.uri !== params.uri) {
        throw new ApiError(502, "The MCP server returned a different skill");
      }
      const resources = result.skill.resources;
      if (!resources || resources.length === 0) {
        throw new ApiError(
          422,
          "This skill has no digest-backed resources to verify",
        );
      }
      if (resources.length > MAX_FILES_PER_SKILL + 1) {
        throw new ApiError(422, "This skill has too many resource files");
      }

      const root = skillRoot(params.uri);
      const files = [];
      let totalBytes = 0;
      for (const resource of resources) {
        const file = await readVerifiedResource(client, resource);
        totalBytes += file.byteLength;
        if (totalBytes > MAX_TOTAL_SKILL_BYTES) {
          throw new ApiError(422, "This skill exceeds the total size limit");
        }
        files.push({
          path: relativeSkillPath(root, resource.uri),
          content: file.content,
          encoding: file.encoding,
          kind: deriveSkillFileKind(relativeSkillPath(root, resource.uri)),
        });
      }
      const manifest = files.find((file) => file.path === "SKILL.md");
      if (!manifest || manifest.encoding !== "utf8") {
        throw new ApiError(422, "The skill does not provide a text SKILL.md");
      }
      const parsed = parseSkillManifest(manifest.content);
      return {
        uri: params.uri,
        name: parsed.name,
        description: parsed.description,
        content: parsed.content,
        files: files.filter((file) => file.path !== "SKILL.md"),
      };
    },
  });
}

// ===== Internal helpers =====

async function listSkills(
  client: Client,
): Promise<z.infer<typeof EntrySchema>[]> {
  const skills: z.infer<typeof EntrySchema>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await client.request(
      { method: "skills/list", params: cursor ? { cursor } : {} },
      ListResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    );
    skills.push(...result.skills);
    if (skills.length > MAX_CATALOG_SKILLS) {
      throw new ApiError(422, "The MCP server advertises too many skills");
    }
    if (!result.nextCursor) return skills;
    cursor = result.nextCursor;
  }
  throw new ApiError(502, "The MCP server returned too many skill pages");
}

function declaresSkills(session: DirectServerSession): boolean {
  return Object.hasOwn(session.serverExtensions(), MCP_SKILLS_EXTENSION_ID);
}

async function readVerifiedResource(
  client: Client,
  resource: McpSkillResource,
): Promise<{
  content: string;
  encoding: "utf8" | "base64";
  byteLength: number;
}> {
  const response = await client.readResource(
    { uri: resource.uri },
    { timeout: REQUEST_TIMEOUT_MS },
  );
  const item = response.contents.find(
    (content) => content.uri === resource.uri,
  );
  if (!item) throw new ApiError(502, `Missing resource ${resource.uri}`);
  const bytes =
    "blob" in item && typeof item.blob === "string"
      ? Buffer.from(item.blob, "base64")
      : Buffer.from(
          "text" in item && typeof item.text === "string" ? item.text : "",
        );
  if (bytes.length > MAX_SKILL_FILE_BYTES) {
    throw new ApiError(422, `Resource ${resource.uri} exceeds the file limit`);
  }
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== resource.digest) {
    throw new ApiError(
      502,
      `Resource ${resource.uri} failed digest verification`,
    );
  }
  const binary = "blob" in item && typeof item.blob === "string";
  return {
    content: binary ? bytes.toString("base64") : bytes.toString("utf8"),
    encoding: binary ? "base64" : "utf8",
    byteLength: bytes.length,
  };
}

function skillRoot(uri: string): string {
  return uri.endsWith("/SKILL.md") ? uri.slice(0, -"/SKILL.md".length) : uri;
}

function relativeSkillPath(root: string, uri: string): string {
  if (!uri.startsWith(`${root}/`)) {
    throw new ApiError(422, `Resource ${uri} is outside the skill namespace`);
  }
  const path = decodeURIComponent(uri.slice(root.length + 1));
  if (!path || path.split("/").some((part) => part === ".." || part === ".")) {
    throw new ApiError(422, `Resource ${uri} has an unsafe path`);
  }
  return path;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : "";
}

function toMetadata(skill: z.infer<typeof EntrySchema>): McpSkillMetadataInput {
  const name = stringField(skill.frontmatter, "name");
  if (name.length === 0 || name.length > 64) {
    throw new ApiError(422, "MCP Skill name is missing or too long");
  }
  const description = stringField(skill.frontmatter, "description");
  if (description.length > 2_048) {
    throw new ApiError(422, "MCP Skill description is too long");
  }
  return {
    uri: skill.uri,
    name,
    description,
    frontmatter: skill.frontmatter,
    resources: skill.resources ?? null,
  };
}
