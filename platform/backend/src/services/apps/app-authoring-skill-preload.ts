import config from "@/config";
import { applyBuiltInSkillBranding } from "@/skills/built-in-skill-branding";
import {
  builtInSkillSourceRef,
  findBuiltInSkillBySourceRef,
} from "@/skills/built-in-skills";
import { formatSkillActivation } from "@/skills/skill-activation";

// The Build App built-in skill carries the window.archestra SDK contract
// (storage/tools/llm/CSP). builtInSkillId is stable; never changes once shipped.
const BUILD_APP_BUILT_IN_SKILL_ID = "build-app";

/**
 * The Build App built-in skill rendered as a `load_skill` activation block — the
 * exact payload `load_skill` returns — plus its branded name. Preloaded at the
 * app-creation entry points (the `scaffold_app` result and the seeded app
 * conversation) so the authoring model has the namespaced SDK surface
 * (`archestra.storage.user.*`, `archestra.tools.call`, …) in context without
 * having to discover and load the skill itself — the gap that let a model emit
 * the non-existent `archestra.storage.get`.
 *
 * Resolved from the shipped static definition (no DB / sandbox mount / RBAC — the
 * caller is already authoring an app they own), branded like every other
 * built-in skill string. Returns null when the Apps feature is off or the
 * definition is absent, so callers no-op.
 */
export function buildBuildAppSkillActivation(): {
  skillName: string;
  activation: string;
} | null {
  if (!config.apps.enabled) return null;
  const definition = findBuiltInSkillBySourceRef(
    builtInSkillSourceRef(BUILD_APP_BUILT_IN_SKILL_ID),
  );
  if (!definition) return null;
  const skillName = applyBuiltInSkillBranding(definition.name);
  return {
    skillName,
    activation: formatSkillActivation({
      skill: {
        name: skillName,
        content: applyBuiltInSkillBranding(definition.content),
        compatibility: null,
        allowedTools: null,
        templated: false,
      },
      files: [],
      canRunSandbox: false,
      promptContext: null,
    }),
  };
}
