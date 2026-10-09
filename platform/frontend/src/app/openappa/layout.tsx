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
  // `notFound` throws, so it stays outside the catch above.
  if (config?.features.openappaEnabled !== true) {
    // Beta on with OpenAPPA off means the licence is what holds it back.
    if (config?.features.betaEnabled === true)
      return <OpenAppaLicenceRequired />;
    notFound();
  }

  return <OpenAppaPageLayout>{children}</OpenAppaPageLayout>;
}
