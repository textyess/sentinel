import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { App } from "@/App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 2_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

const root = document.getElementById("root");
if (!root) {
    throw new Error("Missing #root element");
}

createRoot(root).render(
    <StrictMode>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem storageKey="sentinel-theme" disableTransitionOnChange>
            <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={150}>
                    <App />
                    <Toaster />
                </TooltipProvider>
            </QueryClientProvider>
        </ThemeProvider>
    </StrictMode>,
);
