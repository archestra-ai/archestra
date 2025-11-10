import type { Metadata } from "next";
import {
  Inter,
  Lato,
  Open_Sans,
  Roboto,
  Source_Sans_3,
} from "next/font/google";
import { PublicEnvScript } from "next-runtime-env";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { PostHogProviderWrapper } from "./_parts/posthog-provider";
import { ArchestraQueryClientProvider } from "./_parts/query-client-provider";
import { AppSidebar } from "./_parts/sidebar";
import { ThemeProvider } from "./_parts/theme-provider";
import "./globals.css";
import { EasterEgg } from "@/components/easter-egg";
import { OnboardingDialogWrapper } from "@/components/onboarding-dialog-wrapper";
import { OrgThemeLoader } from "@/components/org-theme-loader";
import { Toaster } from "@/components/ui/sonner";
import { Version } from "@/components/version";
import { WithAuthCheck } from "./_parts/with-auth-check";
import { AuthProvider } from "./auth/auth-provider";

// Load fonts for white-labeling
const latoFont = Lato({
  subsets: ["latin"],
  weight: ["300", "400", "700", "900"],
  variable: "--font-lato",
});

const interFont = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const openSansFont = Open_Sans({
  subsets: ["latin"],
  variable: "--font-open-sans",
});

const robotoFont = Roboto({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700", "900"],
  variable: "--font-roboto",
});

const sourceSansFont = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-source-sans",
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
      <body
        className={`${latoFont.variable} ${interFont.variable} ${openSansFont.variable} ${robotoFont.variable} ${sourceSansFont.variable} font-sans antialiased`}
      >
        <AuthProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <PostHogProviderWrapper>
              <ArchestraQueryClientProvider>
                <OrgThemeLoader />
                <WithAuthCheck>
                  <SidebarProvider>
                    <AppSidebar />
                    <main className="h-screen w-full flex flex-col bg-background min-w-0">
                      <header className="h-14 border-b border-border flex md:hidden items-center px-6 bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
                        <SidebarTrigger className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2" />
                      </header>
                      <div className="flex-1 min-w-0 overflow-auto flex flex-col">
                        <div className="flex-1">{children}</div>
                        <Version />
                      </div>
                    </main>
                    <Toaster />
                    <EasterEgg />
                    <OnboardingDialogWrapper />
                  </SidebarProvider>
                </WithAuthCheck>
              </ArchestraQueryClientProvider>
            </PostHogProviderWrapper>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
