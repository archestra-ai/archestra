import type { ReactNode } from "react";

export function AuthCallbackLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh w-full items-center justify-center bg-background p-4">
      {children}
    </main>
  );
}
