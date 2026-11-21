import { ConnectionEventDetailPage } from "./page.client";

export default async function ConnectionEventDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  return <ConnectionEventDetailPage id={id} />;
}
