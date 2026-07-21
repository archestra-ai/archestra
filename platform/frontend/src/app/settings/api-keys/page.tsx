import { redirect } from "next/navigation";

// API key management moved onto the account page.
export default function ApiKeysSettingsPage() {
  redirect("/account");
}
