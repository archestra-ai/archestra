import { OpenAppaOverview } from "../_parts/openappa-overview";

export default async function OpenAppaConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <OpenAppaOverview conversationId={conversationId} />;
}
