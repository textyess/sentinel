import { type FormEvent, useState } from "react";
import { Undo2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnv, useUpdateEnv } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import type { EnvPresence } from "@/lib/types";
import { cn } from "@/lib/utils";

type ConfigField =
    | { key: string; label: string; type: "text" | "url" }
    | { key: string; label: string; type: "select"; options: string[] };

const CONFIG_FIELDS: ConfigField[] = [
    { key: "SENTINEL_BASE_URL", label: "Base URL", type: "url" },
    { key: "SENTINEL_LLM_PROVIDER", label: "LLM provider", type: "select", options: ["anthropic", "openai", "bedrock"] },
    { key: "SENTINEL_LLM_MODEL", label: "LLM model", type: "text" },
    { key: "AWS_REGION", label: "AWS region", type: "text" },
    { key: "SENTINEL_HEADLESS", label: "Headless browser", type: "select", options: ["true", "false"] },
];

const SECRET_FIELDS: { key: string; label: string }[] = [
    { key: "SENTINEL_EMAIL", label: "Login email" },
    { key: "SENTINEL_PASSWORD", label: "Login password" },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
    { key: "OPENAI_API_KEY", label: "OpenAI API key" },
    { key: "AWS_ACCESS_KEY_ID", label: "AWS access key id" },
    { key: "AWS_SECRET_ACCESS_KEY", label: "AWS secret access key" },
];

function SettingsForm({ env, onClose }: { env: EnvPresence; onClose: () => void }) {
    const [cleared, setCleared] = useState<Set<string>>(new Set());
    const update = useUpdateEnv();

    const known = new Set([...CONFIG_FIELDS, ...SECRET_FIELDS].map((f) => f.key));
    const extraSecrets = Object.keys(env.keys)
        .filter((k) => !known.has(k))
        .map((k) => ({ key: k, label: k }));
    const secretFields = [...SECRET_FIELDS, ...extraSecrets];

    function toggleClear(key: string, on: boolean) {
        setCleared((prev) => {
            const next = new Set(prev);
            if (on) {
                next.add(key);
            } else {
                next.delete(key);
            }
            return next;
        });
    }

    function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const updates: Record<string, string> = {};
        for (const field of CONFIG_FIELDS) {
            const current = String(f.get(field.key) ?? "").trim();
            // The control's initial value: the echoed server value, else its displayed
            // default (first option for a select, empty for text). Only write a key the
            // user actually changed — never persist a default they didn't pick, and
            // never issue a spurious clear for an untouched empty field.
            const initial = env.values[field.key] ?? (field.type === "select" ? field.options[0] : "");
            if (current !== initial) {
                updates[field.key] = current;
            }
        }
        for (const field of secretFields) {
            if (cleared.has(field.key)) {
                updates[field.key] = "";
            } else {
                const v = String(f.get(field.key) ?? "");
                if (v !== "") {
                    updates[field.key] = v;
                }
            }
        }
        update.mutate(updates, {
            onSuccess: () => {
                toast.success("Settings saved");
                onClose();
            },
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not save settings"),
        });
    }

    return (
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
                <section className="grid gap-4">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Configuration</h3>
                    <div className="grid gap-4 sm:grid-cols-2">
                        {CONFIG_FIELDS.map((field) => (
                            <div key={field.key} className="grid gap-1.5">
                                <Label htmlFor={field.key}>{field.label}</Label>
                                {field.type === "select" ? (
                                    <Select name={field.key} defaultValue={env.values[field.key] ?? field.options[0]}>
                                        <SelectTrigger id={field.key}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {field.options.map((o) => (
                                                <SelectItem key={o} value={o}>
                                                    {o}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <Input
                                        id={field.key}
                                        name={field.key}
                                        type={field.type === "url" ? "url" : "text"}
                                        defaultValue={env.values[field.key] ?? ""}
                                        className="font-mono text-xs"
                                    />
                                )}
                            </div>
                        ))}
                    </div>
                </section>

                <section className="grid gap-4">
                    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Secrets</h3>
                    <p className="-mt-2 text-xs text-muted-foreground">
                        Values never leave the server — only whether each is set. Leave blank to keep the current value.
                    </p>
                    <div className="grid gap-3">
                        {secretFields.map((field) => {
                            const isSet = Boolean(env.keys[field.key]?.set);
                            const isCleared = cleared.has(field.key);
                            return (
                                <div key={field.key} className="grid gap-1.5">
                                    <div className="flex items-center gap-2">
                                        <Label htmlFor={field.key}>{field.label}</Label>
                                        <span
                                            className={cn(
                                                "rounded-full border px-1.5 py-px text-[10px] font-medium",
                                                isSet && !isCleared
                                                    ? "border-pass/30 bg-pass/10 text-pass"
                                                    : "border-border text-muted-foreground",
                                            )}
                                        >
                                            {isCleared ? "will clear" : isSet ? "set" : "unset"}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <Input
                                            id={field.key}
                                            name={field.key}
                                            type="password"
                                            autoComplete="off"
                                            disabled={isCleared}
                                            placeholder={
                                                isCleared
                                                    ? "will be cleared on save"
                                                    : isSet
                                                      ? "•••••••• — leave blank to keep"
                                                      : "not set"
                                            }
                                            className="font-mono text-xs"
                                        />
                                        {isSet &&
                                            (isCleared ? (
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="shrink-0 text-muted-foreground"
                                                    onClick={() => toggleClear(field.key, false)}
                                                    aria-label="Undo clear"
                                                >
                                                    <Undo2Icon className="size-4" />
                                                </Button>
                                            ) : (
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    className="shrink-0 text-muted-foreground hover:text-fail"
                                                    onClick={() => toggleClear(field.key, true)}
                                                >
                                                    Clear
                                                </Button>
                                            ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            <SheetFooter className="flex-row justify-end border-t">
                <Button type="button" variant="ghost" onClick={onClose}>
                    Cancel
                </Button>
                <Button type="submit" disabled={update.isPending}>
                    {update.isPending ? "Saving…" : "Save settings"}
                </Button>
            </SheetFooter>
        </form>
    );
}

export function SettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const { data, isLoading, isError, error } = useEnv(open);

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
                <SheetHeader className="border-b">
                    <SheetTitle>Settings</SheetTitle>
                    <SheetDescription>Applied to the running agent and saved to .env (also used by the CLI).</SheetDescription>
                </SheetHeader>
                {isLoading && (
                    <div className="grid gap-3 p-6">
                        {[0, 1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                        ))}
                    </div>
                )}
                {isError && (
                    <div className="m-6 rounded-xl border border-fail/30 bg-fail/5 p-4 text-sm text-fail">
                        {error instanceof Error ? error.message : "Failed to load settings"}
                    </div>
                )}
                {data && <SettingsForm env={data} onClose={() => onOpenChange(false)} />}
            </SheetContent>
        </Sheet>
    );
}
