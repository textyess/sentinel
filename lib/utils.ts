import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

/** Compact relative time, e.g. "3m ago", "2h ago", "5d ago". */
export function timeAgo(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) {
        return "";
    }
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) {
        return "just now";
    }
    const mins = Math.round(secs / 60);
    if (mins < 60) {
        return `${mins}m ago`;
    }
    const hours = Math.round(mins / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    const days = Math.round(hours / 24);
    if (days < 30) {
        return `${days}d ago`;
    }
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
