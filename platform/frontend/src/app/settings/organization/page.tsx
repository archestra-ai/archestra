import { redirect } from "next/navigation";

// The old combined Organization page split into Appearance and Auth; keep old
// links working by forwarding to the appearance half.
export default function OrganizationSettingsPage() {
  redirect("/settings/appearance");
}
