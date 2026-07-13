"use client";

import { Check, Copy, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type Microsoft365CopilotDeviceStart,
  usePollMicrosoft365CopilotDeviceFlow,
  useStartMicrosoft365CopilotDeviceFlow,
} from "@/lib/microsoft-365-copilot-auth.query";

interface Microsoft365CopilotSignInProps {
  /** Receives the user's Entra refresh token once the device flow completes. */
  onToken: (token: string) => void;
  disabled?: boolean;
}

/**
 * "Sign in with Microsoft" device flow (RFC 8628): shows a one-time code the
 * user enters at microsoft.com/devicelogin, then polls until Entra hands back
 * the refresh token that becomes the Microsoft 365 Copilot provider key.
 */
export function Microsoft365CopilotSignIn({
  onToken,
  disabled,
}: Microsoft365CopilotSignInProps) {
  const start = useStartMicrosoft365CopilotDeviceFlow();
  const poll = usePollMicrosoft365CopilotDeviceFlow();
  const [flow, setFlow] = useState<Microsoft365CopilotDeviceStart | null>(null);
  const [completed, setCompleted] = useState(false);
  const [expired, setExpired] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  // Mutation fns in a ref so the polling effect doesn't restart per render.
  const pollRef = useRef(poll.mutateAsync);
  pollRef.current = poll.mutateAsync;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copyResetTimeout.current), []);

  useEffect(() => {
    if (!flow || completed) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout>;
    // Entra's default device-flow interval is 5s; polling faster only earns
    // slow_down responses, so never go below that even if the payload does.
    let intervalMs = Math.max(flow.interval, 5) * 1000;
    const deadline = Date.now() + flow.expiresIn * 1000;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setExpired(true);
        setFlow(null);
        return;
      }
      let result: Awaited<ReturnType<typeof pollRef.current>>;
      try {
        result = await pollRef.current(flow.deviceCode);
      } catch {
        // network-level failure — transient; keep polling until the deadline
        if (!cancelled) timeout = setTimeout(tick, intervalMs);
        return;
      }
      if (cancelled) return;
      if (!result) {
        // request failed (toast already shown) — abandon this flow
        setFlow(null);
        return;
      }
      if (result.status === "complete") {
        setCompleted(true);
        onTokenRef.current(result.refreshToken);
        return;
      }
      if (result.status === "slow_down") {
        intervalMs += 5000;
      }
      timeout = setTimeout(tick, intervalMs);
    };

    timeout = setTimeout(tick, intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [flow, completed]);

  // Step 1: fetch the device code and show it. We deliberately do NOT open the
  // Microsoft tab here — opening a tab steals focus, and the Clipboard API
  // refuses to write while the document is unfocused, so an auto-copy would
  // silently fail. The copy + open happen together in copyCodeAndOpen (a fresh
  // gesture).
  const begin = async () => {
    setExpired(false);
    setCompleted(false);
    try {
      const result = await start.mutateAsync();
      if (result) setFlow(result);
    } catch {
      // network-level failure — leave the button enabled for another attempt
    }
  };

  const markCopied = () => {
    setCodeCopied(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setCodeCopied(false), 2000);
  };

  // Step 2: copy the code WHILE the page is still focused, then open the
  // Microsoft device-login page. Ordering matters — copying before window.open
  // keeps the document focused for the clipboard write; Entra omits the RFC
  // 8628 verification_uri_complete field, so the copy is the fastest path to a
  // paste.
  const copyCodeAndOpen = async (
    deviceFlow: Microsoft365CopilotDeviceStart,
  ) => {
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      markCopied();
    } catch {
      // clipboard blocked (permissions/focus) — the visible code + copy button
      // remain as a fallback
    }
    window.open(deviceFlow.verificationUri, "_blank", "noopener,noreferrer");
  };

  if (completed) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-4 w-4 text-green-500" />
        Microsoft account linked — you can save the key now.
      </p>
    );
  }

  if (flow) {
    return (
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-xs text-muted-foreground">
          Click below to copy the code and open Microsoft's device sign-in, then
          paste it and approve with your work account.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => copyCodeAndOpen(flow)}
          >
            <MicrosoftLogo className="mr-2 h-4 w-4" />
            Copy code &amp; open Microsoft
          </Button>
          <button
            type="button"
            className="flex items-center gap-1 rounded bg-muted px-2 py-1 font-mono text-sm tracking-widest hover:bg-muted/70"
            aria-label="Copy code"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(flow.userCode);
                markCopied();
              } catch {
                // clipboard blocked — code stays visible to copy manually
              }
            }}
          >
            {flow.userCode}
            {codeCopied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Waiting for authorization…
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || start.isPending}
        onClick={begin}
      >
        {start.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MicrosoftLogo className="mr-2 h-4 w-4" />
        )}
        Sign in with Microsoft
      </Button>
      {expired && (
        <p className="text-xs text-destructive">
          The sign-in expired before it was authorized — try again.
        </p>
      )}
    </div>
  );
}

/** The four-square Microsoft logo (lucide has no brand icon for it). */
function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 23 23"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}
