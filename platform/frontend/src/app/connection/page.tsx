"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

// Each view in its own chunk: the approval page an installer opens does not
// load the Connect page's pickers and instructions, and the other way round.
const ConnectPage = dynamic(() =>
  import("./connect-page").then((module) => module.ConnectPage),
);
const ConnectionConsent = dynamic(() =>
  import("./connection-consent").then((module) => module.ConnectionConsent),
);

export default function ConnectionPage() {
  const searchParams = useSearchParams();
  if (searchParams.get("connectRequest")) return <ConnectionConsent />;
  return <ConnectPage />;
}
