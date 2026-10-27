import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = {
  title: "OpenHarness",
  description:
    "Chat with OpenHarness agents, protocols, apps, plan, skills and subagents.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0e0e11" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

const THEME_SCRIPT = `try{var t=localStorage.getItem('oh-theme');if(t==='light'){var d=document.documentElement;d.classList.add('light');d.classList.remove('dark');d.style.colorScheme='light';}}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <Script id="oh-theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
