import { archestraApiSdk, type ErrorExtended } from "@archestra/shared";
import { notFound } from "next/navigation";
import { ServerErrorFallback } from "@/components/error-fallback";
import { PageLayout } from "@/components/page-layout";
import { getServerApiHeaders } from "@/lib/utils/server";
import { BatteriesUploadAction } from "./_parts/batteries-panel";

export default async function OpenAppaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const headers = await getServerApiHeaders();
    const config = await archestraApiSdk.getConfig({ headers });
    if (config.error) throw config.error;
    if (config.data?.features.openappaEnabled !== true) notFound();
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return (
    <PageLayout
      title="OpenAPPA"
      description="Manage the policy that governs tool calls and their results."
      tabs={[
        { label: "Overview", href: "/openappa" },
        { label: "Batteries", href: "/openappa/batteries" },
        { label: "Policy details", href: "/openappa/policy" },
      ]}
      actionButton={<BatteriesUploadAction />}
    >
      {children}
    </PageLayout>
  );
}
