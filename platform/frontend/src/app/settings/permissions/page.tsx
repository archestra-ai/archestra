import { redirect } from "next/navigation";

export default function PermissionsSettingsPage() {
  redirect("/agents?permissions=all");
}
