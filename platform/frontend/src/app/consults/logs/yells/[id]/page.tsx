import { YellDetailPage } from "./page.client";

export default async function YellDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <YellDetailPage id={id} />;
}
