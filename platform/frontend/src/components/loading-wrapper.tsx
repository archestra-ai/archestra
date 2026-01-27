"use client";

import type { ReactNode } from "react";

interface LoadingWrapperProps {
  isPending: boolean;
  error?: Error | null;
  /** Skeleton/loading UI to show while loading */
  skeleton?: ReactNode;
  /** Error UI to show on error. Falls back to null if not provided. */
  errorFallback?: ReactNode;
  children: ReactNode;
}

export function LoadingWrapper({
  isPending,
  error,
  skeleton = null,
  errorFallback = null,
  children,
}: LoadingWrapperProps) {
  if (isPending) return <>{skeleton}</>;
  if (error) return <>{errorFallback}</>;
  return <>{children}</>;
}
