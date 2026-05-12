"use client";

import { usePublicConfig } from "@/lib/config/config.query";
import { useSession } from "@/lib/auth/auth.query";
import { ADMIN_ROLE_NAME } from "@shared";
import { Hammer } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";

export function MaintenanceOverlay() {
  const pathname = usePathname();
  const { data: config } = usePublicConfig();
  const { data: session, isLoading: isSessionLoading } = useSession();

  const isMaintenanceMode = config?.maintenanceMode ?? false;
  const isAdmin = session?.user.role === ADMIN_ROLE_NAME;

  // Do not block auth routes or if session is still loading
  if (
    !isMaintenanceMode ||
    isAdmin ||
    isSessionLoading ||
    pathname?.startsWith("/auth/")
  ) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4 text-center">
      <div className="max-w-md w-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-xl p-8 flex flex-col items-center gap-6">
        <div className="w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center text-amber-600 dark:text-amber-400">
          <Hammer className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Maintenance in Progress
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            Archestra is currently undergoing scheduled maintenance to improve our services. We&apos;ll be back online shortly.
          </p>
        </div>
        <div className="text-sm text-zinc-500 dark:text-zinc-500 flex flex-col gap-2">
          <span className="italic">Thank you for your patience.</span>
          <Link href="/auth/sign-in" className="text-blue-500 hover:underline">
            Admin Login
          </Link>
        </div>
      </div>
    </div>
  );
}
