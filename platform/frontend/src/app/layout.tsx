import type { Metadata } from "next";
import { Lato } from "next/font/google";
import { ColorModeToggle } from "@/components/color-mode-toggle";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { ArchestraQueryClientProvider } from "./_parts/query-client-provider";
import { AppSidebar } from "./_parts/sidebar";
import { ThemeProvider } from "./_parts/theme-provider";
import "./globals.css";

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
              <main className="h-[100%] w-full">
                <SidebarTrigger className="cursor-pointer" />
                <div className="absolute top-2 right-2">
                  <ColorModeToggle />
                </div>
                {children}
              </main>
            </SidebarProvider>
          </ArchestraQueryClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
