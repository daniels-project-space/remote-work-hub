import type { Metadata } from "next";
import Script from "next/script";
import {
  Newsreader,
  IBM_Plex_Sans,
  IBM_Plex_Mono,
} from "next/font/google";
import { SessionProvider } from "@/components/session-provider";
import { ConvexClientProvider } from "@/components/convex-provider";
import "./globals.css";

const display = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Remote Work Hub",
  description: "Cloud Codex agents using ChatGPT subscription credits per project",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${display.variable} ${sans.variable} ${mono.variable}`}
    >
      <body className="min-h-dvh bg-ink text-paper antialiased">
        <div
          aria-hidden
          className="fixed inset-0 -z-10 overflow-hidden pointer-events-none"
        >
          <div
            className="absolute -top-[40vh] -left-[30vw] w-[80vw] h-[80vw] rounded-full opacity-70"
            style={{
              background:
                "radial-gradient(closest-side, oklch(0.82 0.14 65 / 0.10), transparent 70%)",
            }}
          />
          <div
            className="absolute -bottom-[40vh] -right-[30vw] w-[80vw] h-[80vw] rounded-full opacity-60"
            style={{
              background:
                "radial-gradient(closest-side, oklch(0.55 0.13 250 / 0.10), transparent 70%)",
            }}
          />
          <div
            className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[40vw] h-[40vw] rounded-full opacity-40"
            style={{
              background:
                "radial-gradient(closest-side, oklch(0.78 0.13 160 / 0.05), transparent 70%)",
            }}
          />
          <div className="absolute inset-0 bg-grain opacity-[0.07] mix-blend-overlay" />
          <div
            className="absolute inset-x-0 top-0 h-px"
            style={{
              background:
                "linear-gradient(to right, transparent, oklch(0.82 0.14 65 / 0.4) 30%, oklch(0.82 0.14 65 / 0.4) 70%, transparent)",
            }}
          />
        </div>
        <ConvexClientProvider>
          <SessionProvider>{children}</SessionProvider>
        </ConvexClientProvider>
        <Script
          src="https://jarvis-orcin-six.vercel.app/jarvis-embed.js?v=universal-controls-20260719-1"
          strategy="afterInteractive"
          data-jarvis-app="remote-work-hub"
        />
      </body>
    </html>
  );
}
