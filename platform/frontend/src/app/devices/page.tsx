import { redirect } from "next/navigation";

/**
 * The devices moved to Personal Settings. This address stays for the links
 * that an installed MCP bridge still opens.
 */
export default function DevicesPageRedirect() {
  redirect("/account/devices");
}
