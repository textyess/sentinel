"use client";

import { type ReactNode, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export function Providers({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: { staleTime: 2_000, refetchOnWindowFocus: false, retry: 1 },
                },
            }),
    );

    return (
        <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            storageKey="sentinel-theme"
            disableTransitionOnChange
        >
            <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={150}>
                    {children}
                    <Toaster />
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>
    );
}
