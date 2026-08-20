import { SkillDetailPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function SkillDetailPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SkillDetailPage id={decodeURIComponent(id)} />;
}
