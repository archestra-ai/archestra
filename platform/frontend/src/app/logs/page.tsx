import LogsPageClient from "./page.client";

export const dynamic = "force-dynamic";

export default function LogsPageServer() {
  return <LogsPageClient />;
}
