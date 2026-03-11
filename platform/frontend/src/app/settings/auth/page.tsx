"use client";

import {
  ApiKeysCard,
  ChangePasswordCard,
  SessionsCard,
  TwoFactorCard,
} from "@daveyplate/better-auth-ui";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { PersonalTokenCard } from "@/components/settings/personal-token-card";
import config from "@/lib/config";
import { cn } from "@/lib/utils";

function AuthSettingsContent() {
  const searchParams = useSearchParams();
  const highlight = searchParams.get("highlight");
  const changePasswordRef = useRef<HTMLDivElement>(null);
  const [isPulsing, setIsPulsing] = useState(false);

  useEffect(() => {
    if (highlight === "change-password" && changePasswordRef.current) {
      changePasswordRef.current.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      setIsPulsing(true);
      const timer = setTimeout(() => setIsPulsing(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [highlight]);

  return (
    <div className="space-y-6">
      <PersonalTokenCard />
      <ApiKeysCard classNames={{ base: "w-full" }} />
      {!config.disableBasicAuth && (
        <div
          ref={changePasswordRef}
          className={cn(
            "rounded-lg transition-shadow duration-500",
            isPulsing &&
              "ring-2 ring-destructive/50 animate-pulse shadow-lg shadow-destructive/10",
          )}
        >
          <ChangePasswordCard classNames={{ base: "w-full" }} />
        </div>
      )}
      <TwoFactorCard classNames={{ base: "w-full" }} />
      <SessionsCard classNames={{ base: "w-full" }} />
    </div>
  );
}

export default function AuthSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <AuthSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
