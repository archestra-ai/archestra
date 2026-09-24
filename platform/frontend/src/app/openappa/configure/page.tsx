import {
  type OpenAppaPolicyTargetKind,
  openAppaTargetChatTitle,
  openAppaTargetInitialPrompt,
  openAppaTargetSuggestedPrompts,
} from "@archestra/shared";
import { OpenAppaOverview } from "../_parts/openappa-overview";

const POLICY_TARGET_KINDS: readonly OpenAppaPolicyTargetKind[] = [
  "agent",
  "mcp_gateway",
  "mcp_server",
];

function isPolicyTargetKind(
  value: string | undefined,
): value is OpenAppaPolicyTargetKind {
  return (
    value !== undefined &&
    (POLICY_TARGET_KINDS as readonly string[]).includes(value)
  );
}

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

  if (isPolicyTargetKind(targetType) && targetName) {
    return (
      <OpenAppaOverview
        title={openAppaTargetChatTitle(targetName)}
        initialPrompt={openAppaTargetInitialPrompt(targetType, targetName)}
        suggestedPrompts={openAppaTargetSuggestedPrompts(
          targetType,
          targetName,
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
