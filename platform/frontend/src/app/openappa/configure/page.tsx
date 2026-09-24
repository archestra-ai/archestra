import { OpenAppaOverview } from "../_parts/openappa-overview";
import { OpenAppaTargetConfiguration } from "../_parts/openappa-target-configuration";
import { resolveOpenAppaPolicyTarget } from "../_parts/resolve-openappa-policy-target";

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
      initialPrompt={
        start === "review"
          ? "Review my current OpenAPPA policy. Explain what it does, then suggest one useful improvement. Do not change it yet."
          : undefined
      }
    />
  );
}
