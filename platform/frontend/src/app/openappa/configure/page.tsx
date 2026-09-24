import {
  openAppaTargetChatSubtitle,
  openAppaTargetChatTitle,
  openAppaTargetSuggestedPrompts,
} from "@archestra/shared";
import { OpenAppaOverview } from "../_parts/openappa-overview";
import { resolveOpenAppaPolicyTarget } from "../_parts/resolve-openappa-policy-target";

export default async function ConfigureOpenAppaPage({
  searchParams,
}: {
  searchParams: Promise<{
    start?: string;
    targetType?: string;
    targetName?: string;
  }>;
}) {
  const { start, targetType, targetName } = await searchParams;
  const policyTarget = resolveOpenAppaPolicyTarget({ targetType, targetName });

  if (policyTarget) {
    return (
      <OpenAppaOverview
        title={openAppaTargetChatTitle(policyTarget.name)}
        subtitle={openAppaTargetChatSubtitle(
          policyTarget.kind,
          policyTarget.name,
        )}
        policyTarget={policyTarget}
        suggestedPrompts={openAppaTargetSuggestedPrompts(
          policyTarget.kind,
          policyTarget.name,
        )}
      />
    );
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
