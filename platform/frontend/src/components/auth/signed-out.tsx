"use client";

import type { ReactNode } from "react";
import { useAuth } from "./auth-context";

interface SignedOutProps {
  children: ReactNode;
}

export function SignedOut({ children }: SignedOutProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  return !user ? <>{children}</> : null;
}
