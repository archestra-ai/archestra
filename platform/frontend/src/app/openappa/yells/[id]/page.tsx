import { YellDetail } from "../../_parts/yell-detail";

export default async function OpenAppaYellPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <YellDetail id={id} />;
}
