import { McpToolCallDetailPage } from "./page.client";

export default async function McpToolCallDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  return <McpToolCallDetailPage id={id} />;
}
