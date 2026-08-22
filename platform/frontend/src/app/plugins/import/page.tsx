import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function ImportPluginPageServer() {
  redirect("/plugins/new?source=marketplace");
}
