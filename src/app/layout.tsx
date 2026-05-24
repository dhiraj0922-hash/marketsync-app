import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppLayoutWrapper } from "@/components/AppLayoutWrapper";
import { AuthProvider } from "@/components/AuthProvider";
import { LocationProvider } from "@/components/LocationContext";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "STOCK DHARMA",
  description: "Inventory command center for restaurant operations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} antialiased h-full`}>
      <body className="font-sans antialiased bg-neutral-50 h-full">
        <AuthProvider>
          <LocationProvider>
            <AppLayoutWrapper>{children}</AppLayoutWrapper>
          </LocationProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
