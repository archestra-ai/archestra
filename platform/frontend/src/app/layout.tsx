import type { Metadata } from "next";
import localFont from "next/font/local";
import { PublicEnvScript } from "next-runtime-env";
import { AppShell } from "./_parts/app-shell";
import { PostHogProviderWrapper } from "./_parts/posthog-provider";
import { ArchestraQueryClientProvider } from "./_parts/query-client-provider";
import { ThemeProvider } from "./_parts/theme-provider";
import "./globals.css";
import { OrgThemeLoader } from "@/components/org-theme-loader";
import { ChatProvider } from "@/contexts/global-chat-context";
import { WebsocketInitializer } from "./_parts/websocket-initializer";
import { WithAuthCheck } from "./_parts/with-auth-check";
import { WithPagePermissions } from "./_parts/with-page-permissions";
import { AuthProvider } from "./auth/auth-provider";

// Load fonts for white-labeling (self-hosted to avoid Google Fonts network
// dependency during Docker builds — Turbopack cannot fetch them reliably)
const latoFont = localFont({
  src: [
    { path: "../fonts/Lato-Light.woff2", weight: "300" },
    { path: "../fonts/Lato-Regular.woff2", weight: "400" },
    { path: "../fonts/Lato-Bold.woff2", weight: "700" },
    { path: "../fonts/Lato-Black.woff2", weight: "900" },
  ],
  variable: "--font-lato",
  display: "swap",
});

const interFont = localFont({
  src: "../fonts/Inter-Variable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

const openSansFont = localFont({
  src: "../fonts/OpenSans-Variable.woff2",
  variable: "--font-open-sans",
  weight: "300 800",
  display: "swap",
});

const robotoFont = localFont({
  src: "../fonts/Roboto-Variable.woff2",
  variable: "--font-roboto",
  weight: "100 900",
  display: "swap",
});

const sourceSansFont = localFont({
  src: "../fonts/SourceSans3-Variable.woff2",
  variable: "--font-source-sans",
  weight: "200 900",
  display: "swap",
});

const jetbrainsMonoFont = localFont({
  src: "../fonts/JetBrainsMono-Variable.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
  display: "swap",
});

const dmSansFont = localFont({
  src: "../fonts/DMSans-Variable.woff2",
  variable: "--font-dm-sans",
  weight: "100 1000",
  display: "swap",
});

const poppinsFont = localFont({
  src: [
    { path: "../fonts/Poppins-Light.woff2", weight: "300" },
    { path: "../fonts/Poppins-Regular.woff2", weight: "400" },
    { path: "../fonts/Poppins-Medium.woff2", weight: "500" },
    { path: "../fonts/Poppins-SemiBold.woff2", weight: "600" },
    { path: "../fonts/Poppins-Bold.woff2", weight: "700" },
  ],
  variable: "--font-poppins",
  display: "swap",
});

const oxaniumFont = localFont({
  src: "../fonts/Oxanium-Variable.woff2",
  variable: "--font-oxanium",
  weight: "200 800",
  display: "swap",
});

const montserratFont = localFont({
  src: "../fonts/Montserrat-Variable.woff2",
  variable: "--font-montserrat",
  weight: "100 900",
  display: "swap",
});

const sourceCodeProFont = localFont({
  src: "../fonts/SourceCodePro-Variable.woff2",
  variable: "--font-source-code-pro",
  weight: "200 900",
  display: "swap",
});

const merriweatherFont = localFont({
  src: "../fonts/Merriweather-Variable.woff2",
  variable: "--font-merriweather",
  weight: "300 900",
  display: "swap",
});

const quicksandFont = localFont({
  src: "../fonts/Quicksand-Variable.woff2",
  variable: "--font-quicksand",
  weight: "300 700",
  display: "swap",
});

const outfitFont = localFont({
  src: "../fonts/Outfit-Variable.woff2",
  variable: "--font-outfit",
  weight: "100 900",
  display: "swap",
});

const plusJakartaSansFont = localFont({
  src: "../fonts/PlusJakartaSans-Variable.woff2",
  variable: "--font-plus-jakarta-sans",
  weight: "200 800",
  display: "swap",
});

const libreBaskervilleFont = localFont({
  src: "../fonts/LibreBaskerville-Variable.woff2",
  variable: "--font-libre-baskerville",
  weight: "400 700",
  display: "swap",
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
        className={`${latoFont.variable} ${interFont.variable} ${openSansFont.variable} ${robotoFont.variable} ${sourceSansFont.variable} ${jetbrainsMonoFont.variable} ${dmSansFont.variable} ${poppinsFont.variable} ${oxaniumFont.variable} ${montserratFont.variable} ${sourceCodeProFont.variable} ${merriweatherFont.variable} ${quicksandFont.variable} ${outfitFont.variable} ${plusJakartaSansFont.variable} ${libreBaskervilleFont.variable} font-sans antialiased`}
      >
        <ArchestraQueryClientProvider>
          <AuthProvider>
            <ChatProvider>
              <ThemeProvider
                attribute="class"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange
              >
                <PostHogProviderWrapper>
                  <OrgThemeLoader />
                  <WithAuthCheck>
                    <WebsocketInitializer />
                    <AppShell>
                      <WithPagePermissions>{children}</WithPagePermissions>
                    </AppShell>
                  </WithAuthCheck>
                </PostHogProviderWrapper>
              </ThemeProvider>
            </ChatProvider>
          </AuthProvider>
        </ArchestraQueryClientProvider>
      </body>
    </html>
  );
}
