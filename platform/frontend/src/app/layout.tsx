import type { Metadata } from "next";
import {
  DM_Sans,
  Inter,
  JetBrains_Mono,
  Lato,
  Libre_Baskerville,
  Merriweather,
  Montserrat,
  Open_Sans,
  Outfit,
  Oxanium,
  Plus_Jakarta_Sans,
  Poppins,
  Quicksand,
  Roboto,
  Source_Code_Pro,
  Source_Sans_3,
} from "next/font/google";
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

const jetbrainsMonoFont = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

// Additional fonts for theme support
const dmSansFont = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

const poppinsFont = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-poppins",
});

const oxaniumFont = Oxanium({
  subsets: ["latin"],
  variable: "--font-oxanium",
});

const montserratFont = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
});

const sourceCodeProFont = Source_Code_Pro({
  subsets: ["latin"],
  variable: "--font-source-code-pro",
});

const merriweatherFont = Merriweather({
  subsets: ["latin"],
  weight: ["300", "400", "700", "900"],
  variable: "--font-merriweather",
});

const quicksandFont = Quicksand({
  subsets: ["latin"],
  variable: "--font-quicksand",
});

const outfitFont = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const plusJakartaSansFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta-sans",
});

const libreBaskervilleFont = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-libre-baskerville",
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
