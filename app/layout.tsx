import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// `cover`, so the page extends under a phone's home indicator and
// env(safe-area-inset-bottom) reports a real number. Without it the inset is
// always 0 on an iPhone and the bottom tab bar's safe-area padding does
// nothing; the rest is what Next.js emits by default.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// No `title.template` here. Every page under app/dashboard sets its own full
// title with the suffix already in it ("Customers | ISPMan"), so a template
// would print the suffix twice. This default covers the pages that set none.
export const metadata: Metadata = {
  title: "ISPMan",
  description:
    "Billing, provisioning and customer accounts for internet service providers.",
  applicationName: "ISPMan",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
