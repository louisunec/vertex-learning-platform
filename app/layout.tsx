import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { PostHogIdentity } from "@/components/home/posthog-identity";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Vertex — Search your learning in plain English",
    template: "%s · Vertex",
  },
  description:
    "Vertex understands what you want to learn and finds the exact lessons across all your courses.",
};

/** Clerk's hosted UI (sign-in, sign-up, user menu) mirrors the dark theme tokens in globals.css. */
const clerkAppearance = {
  variables: {
    colorPrimary: "#31fbb8",
    colorPrimaryForeground: "#0d0e11",
    colorBackground: "#16171b",
    colorForeground: "#ededed",
    colorMutedForeground: "#9eaabf",
    colorMuted: "#101115",
    colorInput: "#101115",
    colorInputForeground: "#ededed",
    colorBorder: "#2e3238",
    colorNeutral: "#ededed",
    colorRing: "rgb(49 251 184 / 0.6)",
    fontFamily: "var(--font-geist), ui-sans-serif, system-ui, sans-serif",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <ClerkProvider appearance={clerkAppearance}>
          <PostHogIdentity />
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
