"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { useCompleteGitHubUserConnection } from "@/lib/runtime-credentials.query";

export default function GitHubConnectionCallback() {
  const router = useRouter();
  const started = useRef(false);
  const complete = useCompleteGitHubUserConnection();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const query = new URLSearchParams(window.location.search);
    const code = query.get("code");
    const state = query.get("state");
    window.history.replaceState(null, "", window.location.pathname);
    if (!code || !state) return;
    complete.mutate(
      { code, state },
      { onSuccess: () => router.replace("/settings/credentials") },
    );
  }, [complete, router]);
  return (
    <div className="space-y-4 p-6">
      <p>
        {complete.isPending
          ? "Connecting your GitHub account…"
          : "Return to Credentials to start GitHub sign-in again."}
      </p>
      <Button
        variant="outline"
        onClick={() => router.replace("/settings/credentials")}
      >
        Back to Credentials
      </Button>
    </div>
  );
}
