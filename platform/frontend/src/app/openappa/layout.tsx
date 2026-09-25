import { archestraApiSdk, type ErrorExtended } from "@archestra/shared";
import { notFound } from "next/navigation";
import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/utils/server";
import { OpenAppaPageLayout } from "./_parts/openappa-page-layout";

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

  return <OpenAppaPageLayout>{children}</OpenAppaPageLayout>;
}
