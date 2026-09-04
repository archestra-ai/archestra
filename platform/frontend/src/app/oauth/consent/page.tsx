import { Suspense } from "react";
import { ConsentForm } from "./consent-form";

export default function OAuthConsentPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Suspense fallback={null}>
        <ConsentForm />
      </Suspense>
    </div>
  );
}
