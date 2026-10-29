import { ConsultDetailPage } from "./page.client";

export default async function ConsultDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  return <ConsultDetailPage id={id} />;
}
