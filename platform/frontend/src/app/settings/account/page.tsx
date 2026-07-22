import { redirect } from "next/navigation";

// The account page moved out of settings to /account.
export default function AccountSettingsPage() {
  redirect("/account");
}
