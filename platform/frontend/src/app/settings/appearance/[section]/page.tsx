import { notFound } from "next/navigation";
import { APPEARANCE_PAGES } from "../_components/appearance-pages";

export default async function AppearanceSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!APPEARANCE_PAGES.some((page) => page.id === section)) notFound();
  return null;
}
