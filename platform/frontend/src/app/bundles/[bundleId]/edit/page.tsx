import { BundleEditPage } from "../../_parts/bundle-editor";

export const dynamic = "force-dynamic";

export default async function EditBundlePageServer({
  params,
}: {
  params: Promise<{ bundleId: string }>;
}) {
  const { bundleId } = await params;
  return <BundleEditPage bundleId={decodeURIComponent(bundleId)} />;
}
