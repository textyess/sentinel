import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle() {
    const { theme, setTheme } = useTheme();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground" aria-label="Toggle theme">
                    <SunIcon className="size-4.5 scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
                    <MoonIcon className="absolute size-4.5 scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem onClick={() => setTheme("light")} data-active={theme === "light"}>
                    <SunIcon /> Light
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("dark")} data-active={theme === "dark"}>
                    <MoonIcon /> Dark
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setTheme("system")} data-active={theme === "system"}>
                    <MonitorIcon /> System
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
