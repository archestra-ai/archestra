import BundleDetailPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function BundleDetailPageServer({
  params,
}: {
  params: Promise<{ bundleId: string }>;
}) {
  const { bundleId } = await params;
  return <BundleDetailPage bundleId={decodeURIComponent(bundleId)} />;
}
