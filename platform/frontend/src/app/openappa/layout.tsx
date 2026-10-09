import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";
import { notFound } from "next/navigation";
import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/utils/server";
import { OpenAppaLicenceRequired } from "./_parts/openappa-licence-required";
import { OpenAppaPageLayout } from "./_parts/openappa-page-layout";

export default async function OpenAppaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let config: archestraApiTypes.GetConfigResponses["200"] | undefined;
  try {
    const headers = await getServerApiHeaders();
    const response = await archestraApiSdk.getConfig({ headers });
    if (response.error) throw response.error;
    config = response.data;
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }
  if (!config) notFound();
  // OpenAPPA is only ever off for want of a licence.
  if (!config.features.openappaEnabled)
    return <OpenAppaLicenceRequired tier={config.smallTeamTier} />;

  return <OpenAppaPageLayout>{children}</OpenAppaPageLayout>;
}
