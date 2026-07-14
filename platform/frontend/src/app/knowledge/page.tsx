"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Bare /knowledge lands on Connectors, the landing tab of the Knowledge
 * tab set (see KNOWLEDGE_TABS in _parts/knowledge-page-layout.tsx).
 * Client-side like /credentials: a server-side redirect() here streams a
 * NEXT_REDIRECT payload that crashes the client router in this Next version.
 */
export default function KnowledgeIndexPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/knowledge/connectors");
  }, [router]);

  return null;
}
