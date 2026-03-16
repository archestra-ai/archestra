import { redirect } from "next/navigation";

export default function AuthSettingsPage() {
  redirect("/settings/api-keys");
}
