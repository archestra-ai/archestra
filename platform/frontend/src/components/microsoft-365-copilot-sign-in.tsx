"use client";

import { Check, ExternalLink, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyableCode } from "@/components/copyable-code";
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
  /**
   * Single-provider surfaces set this to run the fetch step automatically on
   * mount, so the code + instructions appear without a first click. Never opens
   * the provider tab — that stays an explicit click so popup blockers don't eat
   * it.
   */
  autoStart?: boolean;
}

/**
 * "Sign in with Microsoft" device flow (RFC 8628): shows a one-time code the
 * user enters at microsoft.com/devicelogin, then polls until Entra hands back
 * the refresh token that becomes the Microsoft 365 Copilot provider key. Two
 * explicit steps: fetch the code (button or autoStart), then open the Microsoft
 * page (button).
 */
export function Microsoft365CopilotSignIn({
  onToken,
  disabled,
  autoStart,
}: Microsoft365CopilotSignInProps) {
  const start = useStartMicrosoft365CopilotDeviceFlow();
  const poll = usePollMicrosoft365CopilotDeviceFlow();
  const [flow, setFlow] = useState<Microsoft365CopilotDeviceStart | null>(null);
  const [completed, setCompleted] = useState(false);
  const [expired, setExpired] = useState(false);
  // Mutation fns in a ref so the polling effect doesn't restart per render.
  const pollRef = useRef(poll.mutateAsync);
  pollRef.current = poll.mutateAsync;
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

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
  // Microsoft tab here — that is the separate, explicit open step below, kept
  // click-synchronous so popup blockers don't stop it.
  const begin = useCallback(async () => {
    setExpired(false);
    setCompleted(false);
    try {
      const result = await start.mutateAsync();
      if (result) setFlow(result);
    } catch {
      // network-level failure — leave the button enabled for another attempt
    }
  }, [start.mutateAsync]);

  // Step 2: open the Microsoft verification page. Synchronous with the click and
  // opened with noopener so the new tab can't reach back through window.opener.
  const openVerification = (deviceFlow: Microsoft365CopilotDeviceStart) => {
    window.open(deviceFlow.verificationUri, "_blank", "noopener,noreferrer");
  };

  // Auto-run the fetch step (never the open step) on mount for single-provider
  // surfaces. Fires at most once: the ref guards React strict-mode's
  // double-invoke and any re-render, and we skip while a fetch is in flight.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (flow || completed || start.isPending) return;
    autoStartedRef.current = true;
    void begin();
  }, [autoStart, begin, flow, completed, start.isPending]);

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
      <div className="space-y-2 rounded-md border p-3 text-xs text-muted-foreground">
        <p>
          Open Microsoft's device sign-in, enter this code, and approve with
          your work account.
        </p>
        <CopyableCode value={flow.verificationUri} toastMessage="Link copied">
          <a
            href={flow.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-xs underline underline-offset-2 hover:text-foreground"
          >
            {flow.verificationUri}
          </a>
        </CopyableCode>
        <CopyableCode value={flow.userCode} toastMessage="Code copied">
          <code className="font-mono text-sm tracking-widest text-foreground">
            {flow.userCode}
          </code>
        </CopyableCode>
        <Button type="button" size="sm" onClick={() => openVerification(flow)}>
          <ExternalLink className="mr-2 h-4 w-4" />
          Open Microsoft sign-in
        </Button>
        <p className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Waiting for authorization…
        </p>
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
