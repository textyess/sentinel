import { type ComponentProps, type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useAdapters, useCreateProject } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import type { AdapterKind, CreateProjectInput } from "@/lib/types";

function splitList(value: string): string[] {
    return value
        .split(/[,\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

function Field({
    label,
    name,
    hint,
    ...props
}: { label: string; name: string; hint?: string } & ComponentProps<typeof Input>) {
    return (
        <div className="grid gap-1.5">
            <Label htmlFor={name}>{label}</Label>
            <Input id={name} name={name} {...props} />
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function RegisterProjectDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [adapterKind, setAdapterKind] = useState<AdapterKind>("generic");
    const { data: adapters } = useAdapters(open);
    const kinds = adapters?.kinds ?? ["generic"];
    const create = useCreateProject();

    function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const str = (k: string) => String(f.get(k) ?? "").trim();

        const previewEnvIncludes = str("previewEnvIncludes") || "web";
        const body: CreateProjectInput = {
            repo: str("repo"),
            adapterKind,
            previewEnvIncludes,
            mentionHandle: str("mentionHandle") || "@sentinel",
            baselineUrl: str("baselineUrl") || null,
            adapter:
                adapterKind === "generic"
                    ? {
                          auth: {
                              loginPath: str("loginPath"),
                              emailLabel: str("emailLabel"),
                              passwordLabel: str("passwordLabel"),
                              submitNamePattern: str("submitNamePattern"),
                              authenticatedUrlPattern: str("authenticatedUrlPattern"),
                              publicRoutes: splitList(str("publicRoutes")),
                          },
                          emailEnv: str("emailEnv"),
                          passwordEnv: str("passwordEnv"),
                          previewEnvIncludes,
                          pagesPrefix: str("pagesPrefix") || undefined,
                          allowedMutationPatterns: splitList(str("allowedMutationPatterns")),
                      }
                    : null,
        };

        create.mutate(body, {
            onSuccess: () => {
                toast.success(`Registered ${body.repo}`);
                onOpenChange(false);
            },
            onError: (err) => {
                toast.error(err instanceof ApiError ? err.message : "Could not register project");
            },
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
                <DialogHeader className="border-b p-6">
                    <DialogTitle>Register a project</DialogTitle>
                    <DialogDescription>
                        Connect a GitHub repo. Sentinel watches it for <code className="text-foreground">@</code>
                        -mentions and verifies PRs against a baseline it crawls.
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={onSubmit} className="flex max-h-[calc(90vh-9rem)] flex-col overflow-y-auto">
                    <div className="grid gap-5 p-6">
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field
                                label="Repository"
                                name="repo"
                                placeholder="acme/web"
                                hint="owner/name"
                                required
                                autoFocus
                            />
                            <div className="grid gap-1.5">
                                <Label htmlFor="adapterKind">Adapter</Label>
                                <Select value={adapterKind} onValueChange={(v) => setAdapterKind(v as AdapterKind)}>
                                    <SelectTrigger id="adapterKind">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {kinds.map((kind) => (
                                            <SelectItem key={kind} value={kind}>
                                                {kind === "generic"
                                                    ? "Generic app"
                                                    : kind.charAt(0).toUpperCase() + kind.slice(1)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    {adapterKind === "generic"
                                        ? "Describe how to log in below."
                                        : `Uses the built-in ${adapterKind} adapter.`}
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <Field label="Preview env contains" name="previewEnvIncludes" defaultValue="web" />
                            <Field label="Mention handle" name="mentionHandle" defaultValue="@sentinel" />
                        </div>

                        <Field
                            label="Baseline URL"
                            name="baselineUrl"
                            type="url"
                            placeholder="https://app.example.com"
                            hint="The app Sentinel crawls to learn the baseline. Verify still targets the PR preview."
                        />

                        {adapterKind === "generic" && (
                            <div className="grid gap-4 rounded-lg border border-dashed p-4">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium">Generic app config</span>
                                    <Separator className="flex-1" />
                                </div>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field label="Login path" name="loginPath" defaultValue="/login" />
                                    <Field
                                        label="Authenticated URL pattern"
                                        name="authenticatedUrlPattern"
                                        defaultValue="/"
                                    />
                                    <Field label="Email field label" name="emailLabel" defaultValue="Email" />
                                    <Field label="Password field label" name="passwordLabel" defaultValue="Password" />
                                    <Field
                                        label="Submit button pattern"
                                        name="submitNamePattern"
                                        defaultValue="log\s*in"
                                    />
                                    <Field label="Pages prefix" name="pagesPrefix" placeholder="app/ or src/pages/" />
                                    <Field label="Email env var" name="emailEnv" placeholder="SENTINEL_PROJECT_EMAIL" />
                                    <Field
                                        label="Password env var"
                                        name="passwordEnv"
                                        placeholder="SENTINEL_PROJECT_PASSWORD"
                                    />
                                </div>
                                <Field
                                    label="Public routes"
                                    name="publicRoutes"
                                    defaultValue="/login"
                                    hint="comma-separated"
                                />
                                <Field
                                    label="Allowed mutation patterns"
                                    name="allowedMutationPatterns"
                                    defaultValue="^/login$"
                                    hint="auth paths only — anchored with ^. The read-only guard blocks everything else."
                                />
                            </div>
                        )}
                    </div>

                    <DialogFooter className="border-t p-4">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={create.isPending}>
                            {create.isPending ? "Registering…" : "Register project"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
