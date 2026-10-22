import { createHash } from "node:crypto";
import {
  STARTUP_GUARD_FORMAT_VERSION,
  SupportedProvidersSchema,
} from "@archestra/shared";
import { PLUGIN_DELIVERY_MAX_COUNT } from "@archestra/shared/connection-setup";
import { z } from "zod";
import {
  CLAUDE_CODE_GUARD_CLIENT,
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
  KILO_GUARD_CLIENT,
  OPENCODE_GUARD_CLIENT,
} from "./clients";
import { renderStartupGuardScript } from "./startup-guard";
import { renderStartupGuardPowerShell } from "./startup-guard.windows";

const text = z
  .string()
  .max(512)
  .refine(
    (value) =>
      [...value].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    "Control characters are not allowed",
  );
const publicUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Expected a credential-free HTTP URL");

/** Public render parameters only. Secret fields are literal local substitution slots. */
export const StartupGuardArtifactRequestSchema = z.strictObject({
  clientId: z.enum(["claude-code", "codex", "copilot-cli", "opencode", "kilo"]),
  platform: z.enum(["bash", "windows"]),
  context: z.strictObject({
    appName: text,
    healthUrl: publicUrl.nullable(),
    mcp: z
      .strictObject({ serverName: text, url: publicUrl, ref: text.nullable() })
      .nullable(),
    proxy: z
      .strictObject({
        provider: SupportedProvidersSchema,
        providerLabel: text,
        url: publicUrl,
        ref: text.nullable(),
        proxyName: text,
        authMode: z
          .enum(["provider-key", "virtual-key", "primary-providers"])
          .optional(),
        usesModelCatalog: z.boolean().optional(),
        passthroughVirtualKey: z.literal("ARCH_GUARD_PRIVATE_KEY").nullish(),
      })
      .nullable(),
    skills: z
      .strictObject({
        marketplaceName: text,
        cloneUrl: z.literal("ARCH_GUARD_PRIVATE_CLONE_URL"),
        hasSkills: z.boolean().optional(),
        pluginNames: z.array(text).max(PLUGIN_DELIVERY_MAX_COUNT).optional(),
      })
      .nullable(),
  }),
});

export const StartupGuardArtifactSchema = z.object({
  format: z.literal(1),
  version: z.number().int().nonnegative(),
  clientId: StartupGuardArtifactRequestSchema.shape.clientId,
  platform: StartupGuardArtifactRequestSchema.shape.platform,
  source: z.string(),
  sha256: z.string(),
});

/** Deterministic code rendering, with no setup replay, database writes or credentials. */
export function startupGuardArtifact(
  request: z.infer<typeof StartupGuardArtifactRequestSchema>,
) {
  const clients = {
    "claude-code": CLAUDE_CODE_GUARD_CLIENT,
    codex: CODEX_GUARD_CLIENT,
    "copilot-cli": COPILOT_GUARD_CLIENT,
    opencode: OPENCODE_GUARD_CLIENT,
    kilo: KILO_GUARD_CLIENT,
  };
  const client = clients[request.clientId];
  const source =
    request.platform === "windows"
      ? renderStartupGuardPowerShell(request.context, client)
      : renderStartupGuardScript(request.context, client);
  return {
    format: 1 as const,
    version: STARTUP_GUARD_FORMAT_VERSION,
    clientId: request.clientId,
    platform: request.platform,
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
}
