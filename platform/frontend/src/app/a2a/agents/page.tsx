import { permanentRedirect } from "next/navigation";
import { getLegacyA2aAgentsRedirect } from "./redirect";

export const dynamic = "force-dynamic";

export default async function OutboundA2aAgentsPageServer({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  permanentRedirect(getLegacyA2aAgentsRedirect(await searchParams));
}
