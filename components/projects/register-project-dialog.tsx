import { ChevronDownIcon, ShieldAlertIcon, SparklesIcon } from "lucide-react";
import { type ChangeEvent, type ComponentProps, type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { RunLog } from "@/components/live/run-log";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
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
import { useAdapters, useAutodetect, useCreateProject, useTrialBringUp } from "@/hooks/queries";
import { useLiveRun } from "@/hooks/use-live-run";
import { ApiError } from "@/lib/api";
import type { AdapterKind, AutodetectFieldMeta, CreateProjectInput, RunRecipeInput } from "@/lib/types";
import { cn } from "@/lib/utils";

const DEFAULTS = {
    repo: "",
    previewEnvIncludes: "web",
    mentionHandle: "@sentinel",
    baselineUrl: "",
    // "required" | "none" — whether the app needs a login.
    authRequired: "required",
    loginPath: "/login",
    authenticatedUrlPattern: "/",
    emailLabel: "Email",
    passwordLabel: "Password",
    submitNamePattern: "log\\s*in",
    pagesPrefix: "",
    publicRoutes: "/login",
    allowedMutationPatterns: "^/login$",
    // "yes" → read the PR preview URL from GitHub; "no" → Sentinel starts the app itself.
    hasPreview: "yes",
    runInstallCmd: "npm install",
    runStartCmd: "npm run dev",
    runPort: "3000",
    runReadyPath: "/",
    runSecretEnv: "",
    runEnv: "",
};

type FormState = typeof DEFAULTS;

function splitList(value: string): string[] {
    return value
        .split(/[,\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
}

/** Parse a textarea of `KEY=VALUE` lines into a record (blank lines and `#` comments ignored). */
function parseEnvLines(value: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of value.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const eq = trimmed.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

/** The Sentinel-side env var that will hold this repo's test login (mirrors the server). */
function emailEnvName(repo: string): string {
    const base =
        repo
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toUpperCase() || "PROJECT";
    return `SENTINEL_${base}_EMAIL`;
}

function MetaBadge({ meta }: { meta?: AutodetectFieldMeta }) {
    if (!meta) {
        return null;
    }
    const tone = meta.confidence === "high" ? "pass" : meta.confidence === "medium" ? "uncertain" : "fail";
    return (
        <span
            title={meta.source}
            className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                tone === "pass" && "border-pass/25 bg-pass/10 text-pass",
                tone === "uncertain" && "border-uncertain/25 bg-uncertain/10 text-uncertain",
                tone === "fail" && "border-fail/25 bg-fail/10 text-fail",
            )}>
            <span
                className={cn(
                    "size-1.5 rounded-full",
                    tone === "pass" && "bg-pass",
                    tone === "uncertain" && "bg-uncertain",
                    tone === "fail" && "bg-fail",
                )}
            />
            {meta.confidence}
        </span>
    );
}

function Field({
    label,
    name,
    hint,
    meta,
    ...props
}: { label: string; name: string; hint?: string; meta?: AutodetectFieldMeta } & ComponentProps<typeof Input>) {
    return (
        <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
                <Label htmlFor={name}>{label}</Label>
                <MetaBadge meta={meta} />
            </div>
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
    const [form, setForm] = useState<FormState>(DEFAULTS);
    const [advanced, setAdvanced] = useState(false);
    const [meta, setMeta] = useState<Record<string, AutodetectFieldMeta>>({});
    const [notes, setNotes] = useState<string[]>([]);
    const [runId, setRunId] = useState<string | null>(null);
    const [trialRunId, setTrialRunId] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const { data: adapters } = useAdapters(open);
    const kinds = adapters?.kinds ?? ["generic"];
    const create = useCreateProject();
    const detect = useAutodetect();
    const trial = useTrialBringUp();
    const trialLive = useLiveRun(trialRunId);
    const trialing = trial.isPending || trialLive.streaming;
    const trialDone = trialLive.done?.kind === "trial" ? trialLive.done : null;
    const live = useLiveRun(runId);
    // `runId !== null` keeps the button disabled across the gap between the POST
    // resolving and useLiveRun's effect setting streaming=true (no re-enable flicker).
    const detecting = detect.isPending || live.streaming || runId !== null;
    // A public (no-login) generic project: hide the login config and skip the write gate.
    const noAuth = adapterKind === "generic" && form.authRequired === "none";

    const update = (key: keyof FormState) => (e: ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [key]: e.target.value }));

    function reset() {
        setForm(DEFAULTS);
        setAdapterKind("generic");
        setAdvanced(false);
        setMeta({});
        setNotes([]);
        setRunId(null);
        setTrialRunId(null);
        setConfirmOpen(false);
    }

    function handleOpenChange(next: boolean) {
        if (!next) {
            reset();
        }
        onOpenChange(next);
    }

    // Apply the auto-detect proposal once it arrives over SSE.
    useEffect(() => {
        const done = live.done;
        if (!done || done.kind !== "autodetect") {
            return;
        }
        const p = done.proposal;
        setForm((f) => ({
            ...f,
            // Keep the user's own typed values; only fall back to the proposal when blank
            // (the stored baselineUrl is query-stripped, so never clobber a token URL).
            baselineUrl: f.baselineUrl || p.baselineUrl,
            previewEnvIncludes: f.previewEnvIncludes || p.previewEnvIncludes,
            authRequired: p.authRequired ? "required" : "none",
            loginPath: p.adapter.auth.loginPath,
            authenticatedUrlPattern: p.adapter.auth.authenticatedUrlPattern,
            emailLabel: p.adapter.auth.emailLabel,
            passwordLabel: p.adapter.auth.passwordLabel,
            submitNamePattern: p.adapter.auth.submitNamePattern,
            pagesPrefix: p.adapter.pagesPrefix ?? "",
            publicRoutes: p.adapter.auth.publicRoutes.join(", "),
            allowedMutationPatterns: p.adapter.allowedMutationPatterns.join(", "),
        }));
        setMeta(p.fieldMeta);
        setNotes(p.notes);
        setAdvanced(true);
        setRunId(null);
        toast.success("Auto-detect finished — review the proposed settings");
    }, [live.done]);

    useEffect(() => {
        if (live.error) {
            toast.error(live.error);
            setRunId(null);
        }
    }, [live.error]);

    async function runDetect() {
        const repo = form.repo.trim();
        const baselineUrl = form.baselineUrl.trim();
        if (!repo) {
            toast.error("Enter a repository (owner/name) first.");
            return;
        }
        if (!baselineUrl) {
            toast.error("Enter a baseline URL to detect from.");
            return;
        }
        try {
            const { runId: id } = await detect.mutateAsync({
                repo,
                baselineUrl,
                previewEnvIncludes: form.previewEnvIncludes.trim() || "web",
            });
            setRunId(id);
        } catch (err) {
            toast.error(err instanceof ApiError ? err.message : "Could not start auto-detect");
        }
    }

    function buildRunRecipe(): RunRecipeInput {
        const literalEnv = parseEnvLines(form.runEnv);
        const secretEnv = splitList(form.runSecretEnv);
        return {
            installCmd: form.runInstallCmd.trim() || undefined,
            runCmd: form.runStartCmd.trim(),
            port: Number.parseInt(form.runPort, 10) || 3000,
            readyPath: form.runReadyPath.trim() || undefined,
            ...(Object.keys(literalEnv).length > 0 ? { env: literalEnv } : {}),
            ...(secretEnv.length > 0 ? { secretEnv } : {}),
        };
    }

    async function runTrial() {
        const repo = form.repo.trim();
        if (!repo) {
            toast.error("Enter a repository (owner/name) first.");
            return;
        }
        if (!form.runStartCmd.trim()) {
            toast.error("Enter the command that starts your app (e.g. npm run dev).");
            return;
        }
        const port = Number.parseInt(form.runPort, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
            toast.error("Enter a valid port the app listens on (1–65535).");
            return;
        }
        try {
            const { runId: id } = await trial.mutateAsync({ repo, runRecipe: buildRunRecipe() });
            setTrialRunId(id);
        } catch (err) {
            toast.error(err instanceof ApiError ? err.message : "Could not start the trial bring-up");
        }
    }

    function doSubmit() {
        const previewEnvIncludes = form.previewEnvIncludes.trim() || "web";
        const runRecipe: RunRecipeInput | null = form.hasPreview === "no" ? buildRunRecipe() : null;
        const body: CreateProjectInput = {
            repo: form.repo.trim(),
            adapterKind,
            previewEnvIncludes,
            mentionHandle: form.mentionHandle.trim() || "@sentinel",
            baselineUrl: form.baselineUrl.trim() || null,
            runRecipe,
            adapter:
                adapterKind === "generic"
                    ? {
                          // For a public app the login fields are inert and hidden — send the
                          // valid defaults so a previously-edited/empty field can't 400 the register.
                          auth: {
                              loginPath: noAuth ? DEFAULTS.loginPath : form.loginPath.trim(),
                              emailLabel: noAuth ? DEFAULTS.emailLabel : form.emailLabel.trim(),
                              passwordLabel: noAuth ? DEFAULTS.passwordLabel : form.passwordLabel.trim(),
                              submitNamePattern: noAuth ? DEFAULTS.submitNamePattern : form.submitNamePattern.trim(),
                              authenticatedUrlPattern: noAuth
                                  ? DEFAULTS.authenticatedUrlPattern
                                  : form.authenticatedUrlPattern.trim(),
                              publicRoutes: splitList(form.publicRoutes),
                          },
                          authRequired: !noAuth,
                          previewEnvIncludes,
                          pagesPrefix: form.pagesPrefix.trim() || undefined,
                          // A public app has no login POST to permit — keep the allow-list empty.
                          allowedMutationPatterns: noAuth ? [] : splitList(form.allowedMutationPatterns),
                      }
                    : null,
        };

        create.mutate(body, {
            onSuccess: () => {
                toast.success(
                    noAuth
                        ? `Registered ${body.repo} — public app, no login needed`
                        : `Registered ${body.repo} — set its login in Settings (${emailEnvName(body.repo)})`,
                );
                handleOpenChange(false);
            },
            onError: (err) => {
                toast.error(err instanceof ApiError ? err.message : "Could not register project");
            },
        });
    }

    function onSubmit(e: FormEvent<HTMLFormElement>) {
        e.preventDefault();
        if (!form.repo.trim()) {
            toast.error("Enter a repository (owner/name).");
            return;
        }
        // No-preview projects must declare how to start the app.
        if (form.hasPreview === "no") {
            if (!form.runStartCmd.trim()) {
                toast.error("Enter the command that starts your app (e.g. npm run dev).");
                return;
            }
            const port = Number.parseInt(form.runPort, 10);
            if (!Number.isFinite(port) || port <= 0 || port > 65535) {
                toast.error("Enter a valid port the app listens on (1–65535).");
                return;
            }
        }
        // A public (no-login) project has no write allow-list to validate or confirm.
        if (adapterKind === "generic" && !noAuth) {
            const patterns = splitList(form.allowedMutationPatterns);
            const unanchored = patterns.filter((p) => !p.startsWith("^"));
            if (unanchored.length > 0) {
                setAdvanced(true);
                toast.error(`Mutation patterns must be anchored with ^ (auth paths only): ${unanchored.join(", ")}`);
                return;
            }
            // The write allow-list is the read-only safety boundary — confirm any non-empty
            // set before registering, whether auto-detected or hand-typed.
            if (patterns.length > 0) {
                setConfirmOpen(true);
                return;
            }
        }
        doSubmit();
    }

    const mutationPatterns = splitList(form.allowedMutationPatterns);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
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
                                value={form.repo}
                                onChange={update("repo")}
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
                                        ? "Auto-detect or describe how to log in below."
                                        : `Uses the built-in ${adapterKind} adapter.`}
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid gap-1.5">
                                <Label htmlFor="hasPreview">Preview environment</Label>
                                <Select
                                    value={form.hasPreview}
                                    onValueChange={(v) => setForm((f) => ({ ...f, hasPreview: v }))}>
                                    <SelectTrigger id="hasPreview">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="yes">PR deploys a preview</SelectItem>
                                        <SelectItem value="no">No preview — start it for me</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    {form.hasPreview === "yes"
                                        ? "Sentinel reads the PR's preview URL from GitHub."
                                        : "Sentinel checks out the PR branch and runs the app itself."}
                                </p>
                            </div>
                            <Field
                                label="Mention handle"
                                name="mentionHandle"
                                value={form.mentionHandle}
                                onChange={update("mentionHandle")}
                            />
                        </div>

                        {form.hasPreview === "yes" ? (
                            <Field
                                label="Preview env contains"
                                name="previewEnvIncludes"
                                hint="substring of the preview deployment's environment name (e.g. web)"
                                value={form.previewEnvIncludes}
                                onChange={update("previewEnvIncludes")}
                            />
                        ) : (
                            <div className="grid gap-4 rounded-lg border border-dashed p-4">
                                <span className="text-sm font-medium">How to start the app</span>
                                <p className="text-xs text-muted-foreground">
                                    Sentinel runs these from the PR's checked-out branch, then points the browser at the
                                    local port. The app receives only the env you declare here — never Sentinel's own
                                    secrets.
                                </p>
                                <div className="grid gap-4 sm:grid-cols-2">
                                    <Field
                                        label="Install command"
                                        name="runInstallCmd"
                                        placeholder="npm install"
                                        value={form.runInstallCmd}
                                        onChange={update("runInstallCmd")}
                                    />
                                    <Field
                                        label="Start command"
                                        name="runStartCmd"
                                        placeholder="npm run dev"
                                        value={form.runStartCmd}
                                        onChange={update("runStartCmd")}
                                    />
                                    <Field
                                        label="Port"
                                        name="runPort"
                                        inputMode="numeric"
                                        placeholder="3000"
                                        value={form.runPort}
                                        onChange={update("runPort")}
                                    />
                                    <Field
                                        label="Ready path"
                                        name="runReadyPath"
                                        placeholder="/"
                                        value={form.runReadyPath}
                                        onChange={update("runReadyPath")}
                                    />
                                </div>
                                <Field
                                    label="Secret env vars"
                                    name="runSecretEnv"
                                    hint="comma-separated NAMES — values come from Settings, never stored here"
                                    value={form.runSecretEnv}
                                    onChange={update("runSecretEnv")}
                                />
                                <div className="grid gap-1.5">
                                    <Label htmlFor="runEnv">Non-secret env</Label>
                                    <textarea
                                        id="runEnv"
                                        name="runEnv"
                                        rows={3}
                                        className="rounded-md border bg-transparent px-3 py-2 font-mono text-xs"
                                        placeholder={"NEXT_PUBLIC_API_URL=https://staging.api\nFEATURE_FLAG=on"}
                                        value={form.runEnv}
                                        onChange={(e) => setForm((f) => ({ ...f, runEnv: e.target.value }))}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        One KEY=VALUE per line. Safe, non-secret config only.
                                    </p>
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    <Button type="button" variant="secondary" onClick={runTrial} disabled={trialing}>
                                        <SparklesIcon />
                                        {trialing ? "Starting…" : "Test bring-up"}
                                    </Button>
                                    <span className="text-xs text-muted-foreground">
                                        Sentinel clones the default branch, runs this recipe, and checks the app answers
                                        — proving it before you register.
                                    </span>
                                </div>
                                {trialRunId && (trialLive.streaming || trialLive.lines.length > 0) && (
                                    <div className="h-40">
                                        <RunLog lines={trialLive.lines} streaming={trialLive.streaming} />
                                    </div>
                                )}
                                {trialDone && (
                                    <p className={cn("text-xs font-medium", trialDone.ok ? "text-pass" : "text-fail")}>
                                        {trialDone.ok
                                            ? `✓ Started and reachable at ${trialDone.baseUrl}`
                                            : "✗ Bring-up failed — see the log above."}
                                    </p>
                                )}
                                {trialLive.error && (
                                    <p className="text-xs font-medium text-fail">✗ {trialLive.error}</p>
                                )}
                            </div>
                        )}

                        <div className="grid gap-1.5">
                            <Label htmlFor="baselineUrl">Baseline URL</Label>
                            <div className="flex gap-2">
                                <Input
                                    id="baselineUrl"
                                    name="baselineUrl"
                                    type="url"
                                    placeholder="https://app.example.com"
                                    className="flex-1"
                                    value={form.baselineUrl}
                                    onChange={update("baselineUrl")}
                                />
                                {adapterKind === "generic" && (
                                    <Button type="button" variant="secondary" onClick={runDetect} disabled={detecting}>
                                        <SparklesIcon />
                                        {detecting ? "Detecting…" : "Auto-detect"}
                                    </Button>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                The app Sentinel crawls to learn the baseline. Auto-detect reads its login page to fill
                                in the config below.
                            </p>
                        </div>

                        {adapterKind === "generic" && (
                            <div className="grid gap-4 rounded-lg border border-dashed p-4">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm font-medium">Login &amp; safety</span>
                                    <Separator className="hidden flex-1 sm:block" />
                                    <Select
                                        value={form.authRequired}
                                        onValueChange={(v) => setForm((f) => ({ ...f, authRequired: v }))}>
                                        <SelectTrigger className="w-[180px]" aria-label="Authentication">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="required">Login required</SelectItem>
                                            <SelectItem value="none">No login (public)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    {!noAuth && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setAdvanced((v) => !v)}
                                            aria-expanded={advanced}>
                                            <ChevronDownIcon
                                                className={cn("transition-transform", advanced && "rotate-180")}
                                            />
                                            {advanced ? "Hide" : "Advanced"}
                                        </Button>
                                    )}
                                </div>

                                {noAuth ? (
                                    <p className="text-xs text-muted-foreground">
                                        This app is public — Sentinel crawls and verifies it without signing in. No
                                        credentials needed, and no write paths are permitted (fully read-only).
                                    </p>
                                ) : (
                                    <p className="text-xs text-muted-foreground">
                                        Sentinel signs in to crawl the app. The defaults fit a typical email/password
                                        form — or let Auto-detect read your login page. Test credentials are set later
                                        in Settings (
                                        <code className="text-foreground">
                                            {emailEnvName(form.repo || "your-repo")}
                                        </code>
                                        ).
                                    </p>
                                )}

                                {runId && (live.streaming || live.lines.length > 0) && (
                                    <div className="h-40">
                                        <RunLog lines={live.lines} streaming={live.streaming} />
                                    </div>
                                )}

                                {notes.length > 0 && (
                                    <ul className="grid gap-1 rounded-md border border-uncertain/25 bg-uncertain/10 p-3 text-xs text-foreground">
                                        {notes.map((note) => (
                                            <li key={note} className="flex gap-2">
                                                <span aria-hidden className="text-uncertain">
                                                    !
                                                </span>
                                                <span>{note}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                {!noAuth && advanced && (
                                    <>
                                        <div className="grid gap-4 sm:grid-cols-2">
                                            <Field
                                                label="Login path"
                                                name="loginPath"
                                                value={form.loginPath}
                                                onChange={update("loginPath")}
                                                meta={meta["auth.loginPath"]}
                                            />
                                            <Field
                                                label="Authenticated URL pattern"
                                                name="authenticatedUrlPattern"
                                                value={form.authenticatedUrlPattern}
                                                onChange={update("authenticatedUrlPattern")}
                                                meta={meta["auth.authenticatedUrlPattern"]}
                                            />
                                            <Field
                                                label="Email field label"
                                                name="emailLabel"
                                                value={form.emailLabel}
                                                onChange={update("emailLabel")}
                                                meta={meta["auth.emailLabel"]}
                                            />
                                            <Field
                                                label="Password field label"
                                                name="passwordLabel"
                                                value={form.passwordLabel}
                                                onChange={update("passwordLabel")}
                                                meta={meta["auth.passwordLabel"]}
                                            />
                                            <Field
                                                label="Submit button pattern"
                                                name="submitNamePattern"
                                                value={form.submitNamePattern}
                                                onChange={update("submitNamePattern")}
                                                meta={meta["auth.submitNamePattern"]}
                                            />
                                            <Field
                                                label="Pages prefix"
                                                name="pagesPrefix"
                                                placeholder="app/ or src/pages/"
                                                value={form.pagesPrefix}
                                                onChange={update("pagesPrefix")}
                                                meta={meta.pagesPrefix}
                                            />
                                        </div>
                                        <Field
                                            label="Public routes"
                                            name="publicRoutes"
                                            hint="comma-separated"
                                            value={form.publicRoutes}
                                            onChange={update("publicRoutes")}
                                            meta={meta["auth.publicRoutes"]}
                                        />
                                        <Field
                                            label="Allowed mutation patterns"
                                            name="allowedMutationPatterns"
                                            hint="auth paths only — anchored with ^. The read-only guard blocks everything else."
                                            value={form.allowedMutationPatterns}
                                            onChange={update("allowedMutationPatterns")}
                                            meta={meta.allowedMutationPatterns}
                                        />
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    <DialogFooter className="border-t p-4">
                        <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={create.isPending}>
                            {create.isPending ? "Registering…" : "Register project"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>

            {/* Mutation-pattern confirmation gate — the read-only safety boundary. */}
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Confirm the write allow-list</DialogTitle>
                        <DialogDescription>
                            These auth-only paths are the <strong>only</strong> writes Sentinel will let through — every
                            other mutating request is blocked by the read-only guard. Confirm they are login endpoints.
                        </DialogDescription>
                    </DialogHeader>
                    <ul className="grid gap-1 rounded-md border border-uncertain/25 bg-uncertain/10 p-3 font-mono text-xs text-foreground">
                        {mutationPatterns.map((p) => (
                            <li key={p} className="flex items-center gap-2">
                                <ShieldAlertIcon className="size-3.5 shrink-0 text-uncertain" />
                                {p}
                            </li>
                        ))}
                    </ul>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button type="button" variant="ghost">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button
                            type="button"
                            disabled={create.isPending}
                            onClick={() => {
                                setConfirmOpen(false);
                                doSubmit();
                            }}>
                            Confirm &amp; register
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Dialog>
    );
}
