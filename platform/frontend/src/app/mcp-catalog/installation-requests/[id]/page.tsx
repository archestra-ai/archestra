import { Suspense } from "react";
import { withAuthCheck } from "@/app/_parts/with-auth-check";
import InstallationRequestDetailPageClient from "./page.client";

interface PageProps {
  params: Promise<{ id: string }>;
}

async function InstallationRequestDetailPage(props: PageProps) {
  const params = await props.params;
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <InstallationRequestDetailPageClient id={params.id} />
    </Suspense>
  );
}

export default withAuthCheck(InstallationRequestDetailPage);
