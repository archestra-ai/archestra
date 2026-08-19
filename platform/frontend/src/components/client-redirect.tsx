"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Forwards a retired route to its replacement.
 *
 * A server-side `redirect()` streams a NEXT_REDIRECT payload that crashes the
 * client router in this Next version ("Rendered more hooks than during the
 * previous render"), leaving the error boundary's "This page couldn't load"
 * where the redirect should have been — so these forwards run client-side.
 * See `app/knowledge/page.tsx` for the same workaround.
 */
export function ClientRedirect({ to }: { to: string }) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return null;
}
