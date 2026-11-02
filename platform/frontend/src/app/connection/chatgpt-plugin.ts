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
  frontendUrl,
  skills,
}: {
  appName: string;
  gatewayUrl: string;
  frontendUrl: string;
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
  // Keep the onboarding skill separate from every selected shared skill.
  const setupBase = `gateway-setup-${endpointId}`;
  let setupName = setupBase;
  for (
    let suffix = 2;
    skills.some((skill) => skill.name === setupName);
    suffix++
  )
    setupName = `${setupBase}-${suffix}`;
  const setupPath = `skills/${setupName}/SKILL.md`;
  zip.file(
    setupPath,
    [
      "---",
      `name: ${JSON.stringify(setupName)}`,
      'description: "Set up this gateway in ChatGPT and check local sandbox prerequisites before desktop shell commands."',
      "---",
      "",
      "# Set up the gateway",
      "",
      "Connect the gateway account through the plugin's OAuth flow. A successful gateway sign-in does not verify the local desktop sandbox.",
      "",
      "For ChatGPT web chats and dots, use the remote MCP tools and bundled skills. Do not ask people to install local Linux packages for these surfaces.",
      "",
      "For local Work or Codex tasks in the desktop app, complete the terminal setup before running shell commands. Open the connection page below, select ChatGPT, and run its desktop setup command on the computer running the app. This checks the local sandbox before changing client configuration. On Windows, use the Windows command even when the app runs Codex in WSL. Restart ChatGPT after setup.",
      "",
      new URL("/connection?clientId=chatgpt", frontendUrl).href,
      "",
      'The Windows setup checks the default WSL distribution. If the desktop project uses another distribution, set `$env:ARCHESTRA_CODEX_WSL_DISTRIBUTION = "YourDistribution"` in PowerShell before running setup. Verify the harmless command in that desktop project afterward.',
      "",
      "If Linux or WSL reports that bubblewrap is unavailable, have the person install it in that Linux environment: Ubuntu/Debian: `sudo apt install bubblewrap`; Fedora: `sudo dnf install bubblewrap`. Run these in the person's terminal, then rerun desktop setup. Do not run sudo or change system packages without their approval. Native Windows and macOS do not need this Linux package.",
      "",
      "If bubblewrap is installed but cannot create a user namespace, follow https://learn.chatgpt.com/docs/sandboxing#prerequisites. Keep sandbox and Guardrails protections enabled; do not work around a failed sandbox by switching to full access or bypassing approvals.",
      "",
      "After setup, verify one harmless local command and its exit status. A Guardrails approval alone is not proof that the command executed. If execution fails, report the actual error and repair the prerequisite before retrying.",
    ].join("\n"),
  );
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
            onboardingSkill: `./${setupPath}`,
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
  const unportable: string[] = [];
  let byteCount = 0;
  for (const skill of skills) {
    // These require Archestra activation semantics, not a portable SKILL.md.
    if (skill.templated || skill.agentName) {
      omitted.push(skill.name);
      continue;
    }
    // Archestra accepts any name; a SKILL.md name must be portable. The skills
    // marketplace leaves these skills out too.
    if (!isSpecCompliantSkillName(skill.name)) {
      unportable.push(skill.name);
      continue;
    }
    if (names.has(skill.name)) {
      throw new Error(`Skill names must be unique: ${skill.name}`);
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
    unportable,
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
