"use client";

import type { ReactNode } from "react";
import { useAuth } from "./auth-context";

interface SignedInProps {
  children: ReactNode;
}

export function SignedIn({ children }: SignedInProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }

  return user ? <>{children}</> : null;
}
