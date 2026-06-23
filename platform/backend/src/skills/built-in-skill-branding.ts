// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ARCHESTRA_TOOL_PREFIX, DEFAULT_APP_NAME } from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";

/**
 * White-label rebranding for built-in skill text.
 *
 * The shipped built-in skill definitions (`skills/built-in-skills.ts`) hardcode
 * the "Archestra" brand and the default `archestra__` tool-name prefix. When a
 * built-in skill is reconciled into an organization (`syncBuiltInSkills`, and
 * the reset-to-default route), its name, description, body, and bundled files
 * are branded to the org's white-label app name and tool prefix before being
 * written — so the stored row, the `list_skills` catalog, the `load_skill`
 * activation block, and the sandbox mount path all read the org's brand without
 * any per-read rewriting. This mirrors how built-in MCP tools are seeded under
 * the branded tool name.
 *
 * The swap is a no-op unless full white-labeling is active — the branded values
 * then equal the canonical ones — exactly mirroring `getArchestraMcpCatalogName`
 * / `getArchestraToolPrefix`. It relies on the `archestraMcpBranding` singleton
 * already being synced for the target organization, the same assumption every
 * other branded built-in string makes.
 *
 * Only built-in skill text is ever passed through here; user- and import-authored
 * skills are stored verbatim.
 */
export function applyBuiltInSkillBranding(text: string): string {
  const toolPrefix = archestraMcpBranding.toolPrefix;
  const appName = archestraMcpBranding.catalogName;

  let out = text;
  // The two search tokens never overlap — the prefix is lowercase
  // (`archestra__`) and the app name is the capitalized brand (`Archestra`) — so
  // the order is independent. A `from === to` pair (no white-labeling) is
  // skipped so non-branded orgs pay nothing.
  if (toolPrefix !== ARCHESTRA_TOOL_PREFIX) {
    out = out.split(ARCHESTRA_TOOL_PREFIX).join(toolPrefix);
  }
  if (appName !== DEFAULT_APP_NAME) {
    out = out.split(DEFAULT_APP_NAME).join(appName);
  }
  return out;
}
