import { redirect } from "next/navigation";

export default async function OpenAppaConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  redirect(`/chat/${encodeURIComponent(conversationId)}`);
}
