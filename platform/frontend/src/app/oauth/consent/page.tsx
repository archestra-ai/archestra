import { Suspense } from "react";
import { LoadingSpinner } from "@/components/loading";
import { ConsentForm } from "./consent-form";

export default function OAuthConsentPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Suspense
        fallback={<LoadingSpinner className="top-1/2 left-1/2 absolute" />}
      >
        <ConsentForm />
      </Suspense>
    </div>
  );
}
