import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "iRacing Setup Comparison",
  description:
    "Compare which iRacing setup shops sell setups for a given car / track / week.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-950 text-gray-100 font-[family-name:var(--font-inter)]">
        <div className="bg-amber-600/90 text-amber-50 text-center text-sm py-1.5 px-4 font-medium">
          Private MVP -- HYMO and Grid-and-Go scraped; Coach Dave + P1Doks gated
        </div>
        <header className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-6">
            <Link
              href="/"
              className="flex items-center gap-2 text-gray-100 hover:text-white transition-colors duration-150"
            >
              <span className="text-lg font-bold tracking-tight">
                iRacing Setup Comparison
              </span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-gray-300">
              <Link href="/compare" className="hover:text-white">Compare</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-gray-800 py-6 text-center text-sm text-gray-500">
          iRacing Setup Comparison -- Not affiliated with iRacing.com or any setup shop
        </footer>
      </body>
    </html>
  );
}
