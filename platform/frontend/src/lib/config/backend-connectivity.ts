import { archestraApiSdk } from "@shared";
import { useCallback, useEffect, useRef, useState } from "react";

const { getHealth } = archestraApiSdk;

export type BackendConnectionStatus =
  | "initializing"
  | "checking" // First attempt in progress, no UI shown yet
  | "connecting" // First attempt failed, now retrying with UI
  | "connected"
  | "unreachable";

export interface UseBackendConnectivityOptions {
  /**
   * Time in milliseconds before declaring the backend unreachable.
   * Default: 60000 (1 minute)
   */
  timeoutMs?: number;
  /**
   * Initial delay in milliseconds before the first retry.
   * Default: 1000 (1 second)
   */
  initialDelayMs?: number;
  /**
   * Maximum delay in milliseconds between retries.
   * Default: 30000 (30 seconds)
   */
  maxDelayMs?: number;
  /**
   * Whether to automatically start checking connectivity.
   * Default: true
   */
  autoStart?: boolean;
  /**
   * Custom health check function for testing.
   * Default: uses archestraApiSdk.getHealth
   */
  checkHealthFn?: () => Promise<boolean>;
}

export interface UseBackendConnectivityResult {
  /**
   * Current connection status
   */
  status: BackendConnectionStatus;
  /**
   * Number of reconnection attempts made
   */
  attemptCount: number;
  /**
   * Estimated total attempts before timeout is reached
   */
  estimatedTotalAttempts: number;
  /**
   * Time elapsed since starting to connect (in milliseconds)
   */
  elapsedMs: number;
  /**
   * Manually retry the connection
   */
  retry: () => void;
}

/**
 * Calculate the estimated number of attempts before the timeout is reached,
 * based on the exponential backoff schedule.
 */
export function calculateEstimatedTotalAttempts(
  timeoutMs: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  let cumulative = 0;
  let attempts = 1; // first attempt is immediate
  for (let i = 0; cumulative < timeoutMs; i++) {
    const delay = Math.min(initialDelayMs * 2 ** i, maxDelayMs);
    cumulative += delay;
    attempts++;
  }
  return attempts;
}

async function defaultCheckHealth(): Promise<boolean> {
  try {
    const response = await getHealth();
    return response.response.ok;
  } catch {
    return false;
  }
}

/**
 * Hook to check backend connectivity with exponential backoff.
 *
 * - Starts in "connecting" state and checks the /health endpoint
 * - If successful, transitions to "connected"
 * - If failed, retries with exponential backoff (1s, 2s, 4s, 8s, 16s, max 30s)
 * - After 1 minute of failed attempts, transitions to "unreachable"
 */
export function useBackendConnectivity(
  options: UseBackendConnectivityOptions = {},
): UseBackendConnectivityResult {
  const {
    timeoutMs = 60000, // 1 minute
    initialDelayMs = 1000, // 1 second
    maxDelayMs = 30000, // 30 seconds
    autoStart = true,
    checkHealthFn = defaultCheckHealth,
  } = options;

  const [status, setStatus] = useState<BackendConnectionStatus>("initializing");
  const [attemptCount, setAttemptCount] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  const estimatedTotalAttempts = calculateEstimatedTotalAttempts(
    timeoutMs,
    initialDelayMs,
    maxDelayMs,
  );

  // Store options in refs to avoid effect dependency issues
  const optionsRef = useRef({
    timeoutMs,
    initialDelayMs,
    maxDelayMs,
    checkHealthFn,
  });
  optionsRef.current = { timeoutMs, initialDelayMs, maxDelayMs, checkHealthFn };

  const startTimeRef = useRef<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const isMountedRef = useRef(true);

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }, []);

  const attemptConnection = useCallback(
    async (currentAttempt: number) => {
      if (!isMountedRef.current) return;

      const { checkHealthFn, timeoutMs, initialDelayMs, maxDelayMs } =
        optionsRef.current;
      const isHealthy = await checkHealthFn();

      if (!isMountedRef.current) return;

      if (isHealthy) {
        clearTimers();
        setStatus("connected");
        return;
      }

      // First attempt failed - transition from "checking" to "connecting"
      // This ensures we only show the connecting UI after the first failure
      if (currentAttempt === 0) {
        setStatus("connecting");
      }

      // Check if we've exceeded the timeout
      const now = Date.now();
      const elapsed = startTimeRef.current ? now - startTimeRef.current : 0;

      if (elapsed >= timeoutMs) {
        clearTimers();
        setStatus("unreachable");
        return;
      }

      // Calculate next delay with exponential backoff
      const nextDelay = Math.min(
        initialDelayMs * 2 ** currentAttempt,
        maxDelayMs,
      );

      setAttemptCount(currentAttempt + 1);

      // Schedule next attempt
      timeoutRef.current = setTimeout(() => {
        attemptConnection(currentAttempt + 1);
      }, nextDelay);
    },
    [clearTimers],
  );

  const startConnection = useCallback(() => {
    // Reset state - use "checking" for first attempt to avoid flashing UI
    setStatus("checking");
    setAttemptCount(0);
    setElapsedMs(0);
    clearTimers();

    // Record start time
    startTimeRef.current = Date.now();

    // Start elapsed time tracking (1s interval since UI displays seconds)
    elapsedIntervalRef.current = setInterval(() => {
      if (startTimeRef.current && isMountedRef.current) {
        setElapsedMs(Date.now() - startTimeRef.current);
      }
    }, 1000);

    // Start first attempt
    attemptConnection(0);
  }, [attemptConnection, clearTimers]);

  const retry = useCallback(() => {
    startConnection();
  }, [startConnection]);

  // Auto-start on mount if enabled
  useEffect(() => {
    isMountedRef.current = true;

    if (autoStart) {
      startConnection();
    }

    return () => {
      isMountedRef.current = false;
      clearTimers();
    };
  }, [autoStart, startConnection, clearTimers]);

  return {
    status,
    attemptCount,
    estimatedTotalAttempts,
    elapsedMs,
    retry,
  };
}
