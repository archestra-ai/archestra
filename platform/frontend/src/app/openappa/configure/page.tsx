import { OpenAppaOverview } from "../_parts/openappa-overview";
import { OpenAppaTargetConfiguration } from "../_parts/openappa-target-configuration";
import { resolveOpenAppaPolicyTarget } from "../_parts/resolve-openappa-policy-target";

/** Openers that other OpenAPPA pages link to with `?start=`. */
const START_PROMPTS: Record<string, string> = {
  review:
    "Review my current OpenAPPA policy. Explain what it does, then suggest one useful improvement. Do not change it yet.",
  first:
    "Help me set up my first OpenAPPA policy. Look at the tools my agents can use, suggest batteries that cover them, ask what I want to protect, and show me the proposed policy before saving it.",
};

export default async function ConfigureOpenAppaPage({
  searchParams,
}: {
  searchParams: Promise<{
    start?: string;
    targetType?: string;
    targetId?: string;
  }>;
}) {
  const { start, targetType, targetId } = await searchParams;
  const policyTarget = resolveOpenAppaPolicyTarget({
    targetType,
    targetId,
  });

  if (policyTarget) {
    return <OpenAppaTargetConfiguration policyTarget={policyTarget} />;
  }

  return (
    <OpenAppaOverview
      initialPrompt={start ? START_PROMPTS[start] : undefined}
    />
  );
}
