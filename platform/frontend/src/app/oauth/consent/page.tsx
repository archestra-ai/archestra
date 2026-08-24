import { Suspense } from "react";
import { LoadingState } from "@/components/loading";
import { ConsentForm } from "./consent-form";

export default function OAuthConsentPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Suspense fallback={<LoadingState variant="page" />}>
        <ConsentForm />
      </Suspense>
    </div>
  );
}
