"use client";

import type { Session } from "better-auth/types";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";

interface AuthContextValue {
  session: Session | null;
  user: Session["user"] | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  const value: AuthContextValue = {
    session: session ?? null,
    user: session?.user ?? null,
    isLoading: isPending,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
