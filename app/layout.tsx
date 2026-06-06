import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jetbrainsMono = JetBrains_Mono({
    subsets: ["latin"],
    variable: "--font-jetbrains-mono",
    display: "swap",
});

export const metadata: Metadata = {
    title: "Sentinel",
    description: "The eye that watches your browser — a sentinel for your pull requests.",
    icons: {
        // Sentinel's eye, bare for ≤32px. Swaps colorway with the OS theme; PNG is the fallback.
        icon: [
            {
                url: "/brand/sentinel-favicon.svg",
                type: "image/svg+xml",
                media: "(prefers-color-scheme: light)",
            },
            {
                url: "/brand/sentinel-favicon-dark.svg",
                type: "image/svg+xml",
                media: "(prefers-color-scheme: dark)",
            },
            { url: "/brand/png/sentinel-favicon-32.png", type: "image/png", sizes: "32x32" },
        ],
        apple: { url: "/brand/png/sentinel-favicon-180.png", sizes: "180x180" },
    },
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    );
}
