import { OpenAppaOverview } from "../_parts/openappa-overview";
import { resolveOpenAppaPolicyTarget } from "../_parts/resolve-openappa-policy-target";

export default async function OpenAppaConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ targetType?: string; targetName?: string }>;
}) {
  const { conversationId } = await params;
  const { targetType, targetName } = await searchParams;
  return (
    <OpenAppaOverview
      conversationId={conversationId}
      policyTarget={resolveOpenAppaPolicyTarget({ targetType, targetName })}
    />
  );
}
