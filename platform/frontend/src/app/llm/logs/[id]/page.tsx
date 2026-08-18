import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
import { ChatPage } from "./page.client";

export default async function ChatPageServer({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  let initialData: {
    interaction: archestraApiTypes.GetInteractionResponses["200"] | undefined;
  } = {
    interaction: undefined,
  };
  try {
    const headers = await getServerApiHeaders();
    const interactionResponse = await archestraApiSdk.getInteraction({
      headers,
      path: { interactionId: id },
    });
    if (interactionResponse.error) {
      handleApiError(interactionResponse.error);
    }
    initialData = {
      interaction: interactionResponse.data,
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <ChatPage initialData={initialData} id={id} />;
}
