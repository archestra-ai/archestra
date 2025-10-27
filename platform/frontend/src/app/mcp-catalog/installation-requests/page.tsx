import { Suspense } from "react";
import { withAuthCheck } from "@/app/_parts/with-auth-check";
import InstallationRequestsPageClient from "./page.client";

async function InstallationRequestsPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <InstallationRequestsPageClient />
    </Suspense>
  );
}

export default withAuthCheck(InstallationRequestsPage);
