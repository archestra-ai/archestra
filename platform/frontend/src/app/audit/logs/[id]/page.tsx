import { AuditEventDetailPage } from "./page.client";

export default async function AuditEventDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  return <AuditEventDetailPage id={id} />;
}
