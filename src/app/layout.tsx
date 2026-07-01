import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppLayoutWrapper } from "@/components/AppLayoutWrapper";
import { AuthProvider } from "@/components/AuthProvider";
import { LocationProvider } from "@/components/LocationContext";
import { PWARegister } from "@/components/PWARegister";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "STOCK DHARMA",
  description: "Inventory command center for restaurant operations",
  manifest: "/manifest.json",
  applicationName: "STOCK DHARMA",
  appleWebApp: {
    capable: true,
    title: "STOCK DHARMA",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    other: [
      {
        rel: "mask-icon",
        url: "/icons/maskable-icon-512.png",
        color: "#166534",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#166534",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased h-full`}>
      <body className="font-sans antialiased bg-neutral-50 h-full">
        <PWARegister />
        <AuthProvider>
          <LocationProvider>
            <AppLayoutWrapper>{children}</AppLayoutWrapper>
          </LocationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
