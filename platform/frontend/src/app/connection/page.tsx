"use client";

import { useSearchParams } from "next/navigation";
import { ConnectPage } from "./connect-page";
import { ConnectionConsent } from "./connection-consent";

export default function ConnectionPage() {
  const searchParams = useSearchParams();
  if (searchParams.get("connectRequest")) return <ConnectionConsent />;
  return <ConnectPage />;
}
