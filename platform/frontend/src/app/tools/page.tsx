import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { ToolsClient } from "./page.client";

export const dynamic = "force-dynamic";

export default async function ToolsPage() {
  let initialData:
    | archestraApiTypes.GetAllAgentToolsResponses["200"]
    | undefined;
  try {
    const headers = await getServerApiHeaders();
    initialData = (await archestraApiSdk.getAllAgentTools({ headers })).data;
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <ToolsClient initialData={initialData} />;
}
