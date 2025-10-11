import type { Metadata } from "next";
import { Lato } from "next/font/google";
import { PublicEnvScript } from "next-runtime-env";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ArchestraQueryClientProvider } from "./_parts/query-client-provider";
import { AppSidebar } from "./_parts/sidebar";
import { ThemeProvider } from "./_parts/theme-provider";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

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
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ArchestraQueryClientProvider>
            <SidebarProvider>
              <AppSidebar />
              <main className="h-screen w-full flex flex-col bg-background">
                <header className="h-14 border-b border-border flex items-center justify-between px-6 bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
                  <SidebarTrigger className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2" />
                  <ColorModeToggle />
                </header>
                <div className="flex-1 overflow-auto">{children}</div>
              </main>
              <Toaster />
            </SidebarProvider>
          </ArchestraQueryClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
