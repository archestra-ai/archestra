"use client";

import { usePathname } from "next/navigation";
import { ConversationSearchProvider } from "@/components/conversation-search-provider";
import { OnboardingDialogWrapper } from "@/components/onboarding-dialog-wrapper";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Version } from "@/components/version";
import { AppSidebar } from "./sidebar";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isBrowserPreview = pathname.startsWith("/chat/browser-preview/");

  // Browser preview mode: render children directly without sidebar/header/version
  if (isBrowserPreview) {
    return (
      <>
        {children}
        <Toaster />
      </>
    );
  }

  // Normal mode: render full app shell with sidebar
  return (
    <SidebarProvider>
      <AppSidebar />
      <main className="h-screen w-full flex flex-col bg-background min-w-0 relative">
        <header className="h-14 border-b border-border flex md:hidden items-center px-6 bg-card/50 backdrop-blur supports-backdrop-filter:bg-card/50">
          <SidebarTrigger className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2" />
        </header>
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 flex flex-col">{children}</div>
          <Version />
        </div>
      </main>
      <Toaster />
      <OnboardingDialogWrapper />
      <ConversationSearchProvider />
    </SidebarProvider>
  );
}
