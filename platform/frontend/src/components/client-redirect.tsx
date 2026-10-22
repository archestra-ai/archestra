"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Sends a bare section root to its first destination.
 * A server-side redirect() here streams a NEXT_REDIRECT payload that crashes
 * the client router in this Next version, so the redirect stays client-side.
 */
export function ClientRedirect({
  to,
  keepQuery = false,
}: {
  to: string;
  /** Carry the current query string and hash over to `to`. */
  keepQuery?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    router.replace(
      keepQuery ? `${to}${window.location.search}${window.location.hash}` : to,
    );
  }, [router, to, keepQuery]);

  return null;
}
