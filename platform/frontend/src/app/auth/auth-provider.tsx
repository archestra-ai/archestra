"use client";

import type { ReactNode } from "react";
import { AuthProvider as CustomAuthProvider } from "@/components/auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  return <CustomAuthProvider>{children}</CustomAuthProvider>;
}
