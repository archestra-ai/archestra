"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Bare /knowledge lands on Connectors, the first Knowledge destination in the
 * sidebar.
 * A server-side redirect() here streams a NEXT_REDIRECT payload that crashes
 * the client router in this Next version, so this redirect stays client-side.
 */
export default function KnowledgeIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/knowledge/connectors");
  }, [router]);

  return null;
}
