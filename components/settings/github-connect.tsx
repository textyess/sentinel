import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopyIcon, ExternalLinkIcon, GithubIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { keys, useDisconnectGithub, useGithubAuth, useHealth, useStartGithubLogin } from "@/hooks/queries";
import { ApiError } from "@/lib/api";

/**
 * Settings panel "Connect GitHub" — runs the OAuth device flow so the operator
 * never has to hand-create a PAT: click, approve the one-time code on github.com,
 * and the server stores the minted token as GH_TOKEN in .env.
 */
export function GithubConnect() {
    const { data } = useGithubAuth(true);
    const { data: health } = useHealth();
    const start = useStartGithubLogin();
    const disconnect = useDisconnectGithub();
    const qc = useQueryClient();
    const [copied, setCopied] = useState(false);

    const flow = data?.flow ?? { state: "idle" as const };

    // The poll loop completes server-side; when the status flips to connected,
    // refresh the health dot and the GH_TOKEN "set" badge to match.
    useEffect(() => {
        if (flow.state === "connected") {
            qc.invalidateQueries({ queryKey: keys.health });
            qc.invalidateQueries({ queryKey: keys.env });
        }
    }, [flow.state, qc]);

    function onStart() {
        start.mutate(undefined, {
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not start GitHub login"),
        });
    }

    function onDisconnect() {
        disconnect.mutate(undefined, {
            onError: (err) => toast.error(err instanceof ApiError ? err.message : "Could not disconnect GitHub"),
        });
    }

    async function copyCode(code: string) {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    const connectedAs = flow.state === "connected" ? flow.login : null;
    const isConnected = flow.state === "connected" || Boolean(data?.tokenSet) || Boolean(health?.ghAuthOk);

    return (
        <section className="grid gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">GitHub access</h3>

            {flow.state === "pending" ? (
                <div className="grid gap-3 rounded-xl border bg-card/60 p-4">
                    <p className="text-xs text-muted-foreground">
                        Enter this one-time code on github.com to authorize Sentinel. This panel updates automatically
                        once you approve.
                    </p>
                    <div className="flex items-center gap-2">
                        <code className="rounded-lg border bg-muted/40 px-3 py-1.5 font-mono text-base font-semibold tracking-[0.2em]">
                            {flow.userCode}
                        </code>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => copyCode(flow.userCode)}
                            aria-label="Copy code">
                            {copied ? <CheckIcon className="size-4 text-pass" /> : <CopyIcon className="size-4" />}
                        </Button>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button type="button" size="sm" asChild>
                            <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                                Open github.com
                                <ExternalLinkIcon className="size-3.5" />
                            </a>
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={onDisconnect}
                            disabled={disconnect.isPending}>
                            Cancel
                        </Button>
                    </div>
                </div>
            ) : isConnected ? (
                <div className="flex items-center justify-between rounded-xl border bg-card/60 p-4">
                    <div className="flex items-center gap-2 text-sm">
                        <span className="size-2 rounded-full bg-pass" />
                        <span>
                            {connectedAs ? (
                                <>
                                    Connected as <span className="font-medium">@{connectedAs}</span>
                                </>
                            ) : data?.tokenSet ? (
                                "Connected (GH_TOKEN set)"
                            ) : (
                                "Connected (gh CLI authenticated)"
                            )}
                        </span>
                    </div>
                    {(data?.tokenSet || connectedAs) && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-fail"
                            onClick={onDisconnect}
                            disabled={disconnect.isPending}>
                            Disconnect
                        </Button>
                    )}
                </div>
            ) : (
                <div className="grid gap-3 rounded-xl border bg-card/60 p-4">
                    {flow.state === "error" && <p className="text-xs text-fail">{flow.message}</p>}
                    <p className="text-xs text-muted-foreground">
                        Sentinel needs GitHub access to watch PRs and post verdicts. Sign in once and the token is saved
                        for you — no manual token needed. Sign in with the account that should appear as the bot (a
                        dedicated account is recommended).
                    </p>
                    <div>
                        <Button type="button" size="sm" onClick={onStart} disabled={start.isPending}>
                            <GithubIcon className="size-4" />
                            {start.isPending ? "Starting…" : "Connect GitHub"}
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}
