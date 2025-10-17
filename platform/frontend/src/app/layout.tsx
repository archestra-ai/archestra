import type { Metadata } from "next";
import { Lato } from "next/font/google";
import { PublicEnvScript } from "next-runtime-env";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { PostHogProviderWrapper } from "./_parts/posthog-provider";
import { ArchestraQueryClientProvider } from "./_parts/query-client-provider";
import { AppSidebar } from "./_parts/sidebar";
import { ThemeProvider } from "./_parts/theme-provider";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "./auth/auth-provider";

const mainFont = Lato({
  subsets: ["latin"],
  weight: ["300", "400", "700", "900"],
  variable: "--font-saira",
});

export const metadata: Metadata = {
  title: "Archestra.AI",
  description: "Enterprise MCP Platform for AI Agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <PublicEnvScript />
      </head>
      <body className={`${mainFont.className} antialiased`}>
        <AuthProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <PostHogProviderWrapper>
              <ArchestraQueryClientProvider>
                <SidebarProvider>
                  <AppSidebar />
                  <main className="h-screen w-full flex flex-col bg-background min-w-0">
                    <header className="h-14 border-b border-border flex md:hidden items-center px-6 bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
                      <SidebarTrigger className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2" />
                    </header>
                    <div className="flex-1 min-w-0">{children}</div>
                  </main>
                  <Toaster />
                </SidebarProvider>
              </ArchestraQueryClientProvider>
            </PostHogProviderWrapper>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
