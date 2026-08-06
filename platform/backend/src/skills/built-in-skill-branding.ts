// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
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
  return archestraMcpBranding.brandBuiltInText(text);
}
