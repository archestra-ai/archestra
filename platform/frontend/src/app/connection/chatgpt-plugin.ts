import {
  type archestraApiTypes,
  isSpecCompliantSkillCompatibility,
  isSpecCompliantSkillDescription,
  isSpecCompliantSkillName,
  MAX_SKILL_COMPATIBILITY_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
} from "@archestra/shared";
import { composeManifest } from "@/lib/skills/manifest-compose";

type Skill = archestraApiTypes.GetSkillResponses["200"];

export async function buildChatgptPlugin({
  appName,
  gatewayUrl,
  skills,
}: {
  appName: string;
  gatewayUrl: string;
  skills: Skill[];
}) {
  validateChatgptGatewayUrl(gatewayUrl);
  const [{ default: JSZip }, { Sha256 }] = await Promise.all([
    import("jszip"),
    import("@aws-crypto/sha256-js"),
  ]);
  const zip = new JSZip();
  // The dashboard can run on HTTP even when the MCP gateway uses HTTPS.
  const hash = new Sha256();
  hash.update(new URL(gatewayUrl).href);
  const endpointId = [...(await hash.digest())]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const name = `${
    appName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/g, "") || "gateway"
  }-connect-${endpointId}`;
  zip.file(
    "plugin.json",
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        version: `1.0.${Math.floor(Date.now() / 1000)}`,
        description: `MCP tools and skills from ${appName}`,
        extensions: {
          "com.openai": {
            interface: {
              displayName: appName,
              shortDescription: "Your team's tools and skills",
              developerName: appName,
              category: "Productivity",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  zip.file(
    "mcp.json",
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          gateway: {
            type: "streamable-http",
            url: gatewayUrl,
            extensions: {
              "com.openai": {
                auth: { type: "oauth", client: { mode: "dcr" } },
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  const names = new Set<string>();
  const omitted: string[] = [];
  let byteCount = 0;
  for (const skill of skills) {
    // These require Archestra activation semantics, not a portable SKILL.md.
    if (skill.templated || skill.agentName) {
      omitted.push(skill.name);
      continue;
    }
    if (!isSpecCompliantSkillName(skill.name) || names.has(skill.name)) {
      throw new Error(
        `Skill names must be unique portable names: ${skill.name}`,
      );
    }
    if (!isSpecCompliantSkillDescription(skill.description)) {
      throw new Error(
        `Skill ${skill.name}: description must contain 1–${MAX_SKILL_DESCRIPTION_LENGTH} characters. Update the skill before downloading.`,
      );
    }
    if (!isSpecCompliantSkillCompatibility(skill.compatibility)) {
      throw new Error(
        `Skill ${skill.name}: compatibility must contain at most ${MAX_SKILL_COMPATIBILITY_LENGTH} characters. Update the skill before downloading.`,
      );
    }
    names.add(skill.name);
    const manifest = composeManifest(skill);
    const manifestBytes = new TextEncoder().encode(manifest).length;
    if (manifestBytes > 1024 * 1024)
      throw new Error(`Skill manifest exceeds 1 MiB: ${skill.name}`);
    byteCount += manifestBytes;
    const paths = new Set(["skill.md"]);
    zip.file(`skills/${skill.name}/SKILL.md`, manifest);
    for (const file of skill.files) {
      const parts = file.path.split("/");
      const key = file.path.toLowerCase();
      if (
        parts.some(
          (part) =>
            !part || part === "." || part === ".." || part.startsWith("."),
        ) ||
        /[\\:]/.test(file.path) ||
        [...file.path].some((character) => character.charCodeAt(0) < 32) ||
        [...paths].some(
          (existing) =>
            key === existing ||
            key.startsWith(`${existing}/`) ||
            existing.startsWith(`${key}/`),
        )
      ) {
        throw new Error(
          `Unsafe or duplicate skill resource path: ${file.path}`,
        );
      }
      paths.add(key);
      const contents =
        file.encoding === "base64"
          ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(file.content);
      byteCount += contents.length;
      zip.file(`skills/${skill.name}/${file.path}`, contents);
    }
    if (byteCount > 20 * 1024 * 1024)
      throw new Error(
        "The selected skills exceed the 20 MiB plugin download limit.",
      );
  }
  return {
    bytes: await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    }),
    filename: `${name}.zip`,
    skillCount: names.size,
    omitted,
  };
}

export function validateChatgptGatewayUrl(gatewayUrl: string) {
  const endpoint = new URL(gatewayUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new Error(
      "Use an HTTPS gateway URL without credentials, query parameters, or a fragment.",
    );
  }
}
