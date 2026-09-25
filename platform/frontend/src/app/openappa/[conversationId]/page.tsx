import { OpenAppaOverview } from "../_parts/openappa-overview";
import { resolveOpenAppaPolicyTarget } from "../_parts/resolve-openappa-policy-target";

export default async function OpenAppaConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{
    targetType?: string;
    targetId?: string;
  }>;
}) {
  const { conversationId } = await params;
  const { targetType, targetId } = await searchParams;
  return (
    <OpenAppaOverview
      conversationId={conversationId}
      policyTarget={resolveOpenAppaPolicyTarget({
        targetType,
        targetId,
      })}
    />
  );
}
