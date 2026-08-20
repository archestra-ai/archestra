import { SkillEditPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function SkillEditPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SkillEditPage id={decodeURIComponent(id)} />;
}
