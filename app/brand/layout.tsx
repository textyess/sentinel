import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
    title: "Sentinel — Brand",
    description: "Brand sheet for Sentinel — the eye that watches your browser.",
};

export default function BrandLayout({ children }: { children: ReactNode }) {
    return children;
}
