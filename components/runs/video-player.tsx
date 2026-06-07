"use client";

import {
    BanIcon,
    CheckIcon,
    ChevronDownIcon,
    EyeIcon,
    HourglassIcon,
    KeyboardIcon,
    type LucideIcon,
    MaximizeIcon,
    MinimizeIcon,
    MousePointer2Icon,
    MousePointerClickIcon,
    MoveVerticalIcon,
    NavigationIcon,
    PauseIcon,
    PlayIcon,
    Volume2Icon,
    VolumeXIcon,
    XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StepAction, StepResultView, StepStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACTION_META: Record<StepAction, { label: string; icon: LucideIcon }> = {
    navigate: { label: "Navigate", icon: NavigationIcon },
    click: { label: "Click", icon: MousePointerClickIcon },
    type: { label: "Type", icon: KeyboardIcon },
    select: { label: "Select", icon: ChevronDownIcon },
    hover: { label: "Hover", icon: MousePointer2Icon },
    scroll: { label: "Scroll", icon: MoveVerticalIcon },
    assert: { label: "Assert", icon: EyeIcon },
    wait: { label: "Wait", icon: HourglassIcon },
};

const STATUS_META: Record<StepStatus, { label: string; marker: string; text: string; icon: LucideIcon | null }> = {
    ok: { label: "Passed", marker: "bg-pass", text: "text-pass", icon: CheckIcon },
    failed: { label: "Failed", marker: "bg-fail", text: "text-fail", icon: XIcon },
    blocked: { label: "Blocked", marker: "bg-blocked", text: "text-blocked", icon: BanIcon },
    skipped: { label: "Skipped", marker: "bg-muted-foreground", text: "text-muted-foreground", icon: null },
};

const PLAYBACK_RATES = [1, 1.5, 2, 0.5] as const;
const PREVIEW_WIDTH = 256;
const SKIP_SECONDS = 5;

/** One step rendered as a chapter on the timeline. */
interface Chapter {
    index: number;
    /** Seconds from video start where the step begins (its marker position). */
    start: number;
    /** Seconds where the next step begins (or video end for the last step). */
    end: number;
    status: StepStatus;
    action: StepAction;
    target: string;
    observation: string;
    screenshotUrl: string | null;
    /** True when timing was unavailable and the position is an even-spread estimate. */
    approximate: boolean;
}

function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }
    const total = Math.floor(seconds);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const mm = hrs > 0 ? String(mins).padStart(2, "0") : String(mins);
    return hrs > 0 ? `${hrs}:${mm}:${String(secs).padStart(2, "0")}` : `${mm}:${String(secs).padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
}

/**
 * Turn the executed steps into timeline chapters. When every step carries a recorded
 * offset we place markers exactly; otherwise (a run from before timing was tracked) we
 * spread them evenly so the feature still works, flagged `approximate`.
 */
function buildChapters(results: StepResultView[], duration: number): Chapter[] {
    if (!duration || results.length === 0) {
        return [];
    }
    const hasTiming = results.every((r) => typeof r.startMs === "number");
    const count = results.length;
    const startOf = (r: StepResultView, i: number): number =>
        hasTiming && typeof r.startMs === "number" ? clamp(r.startMs / 1000, 0, duration) : (i / count) * duration;

    return results.map((r, i) => {
        const start = startOf(r, i);
        const next = results[i + 1];
        const end = next ? Math.max(start, startOf(next, i + 1)) : duration;
        return {
            index: i,
            start,
            end,
            status: r.status,
            action: r.step.action,
            target: r.step.target,
            observation: r.observation,
            screenshotUrl: r.screenshotUrl,
            approximate: !hasTiming,
        };
    });
}

/** The chapter containing time `t` (the one whose window covers it), or -1 for the lead-in. */
function chapterAt(chapters: Chapter[], t: number): number {
    let found = -1;
    for (const c of chapters) {
        if (t >= c.start) {
            found = c.index;
        } else {
            break;
        }
    }
    return found;
}

function StepPreview({ chapter, time }: { chapter: Chapter | undefined; time: number }) {
    if (!chapter) {
        return (
            <div className="rounded-md bg-black/85 px-2 py-1 text-center font-mono text-[11px] tabular-nums text-white shadow-lg ring-1 ring-white/10">
                {formatTime(time)}
            </div>
        );
    }
    const action = ACTION_META[chapter.action];
    const ActionIcon = action.icon;
    const status = STATUS_META[chapter.status];
    const StatusIcon = status.icon;
    return (
        <div className="overflow-hidden rounded-lg bg-[oklch(0.16_0.004_286)] shadow-xl ring-1 ring-white/12">
            <div className="aspect-video w-full bg-black/40">
                {chapter.screenshotUrl ? (
                    // The end-state screenshot is exactly what the agent saw on this step.
                    <img
                        src={chapter.screenshotUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover object-top"
                    />
                ) : (
                    <div className="grid size-full place-items-center text-[11px] text-white/40">no screenshot</div>
                )}
            </div>
            <div className="grid gap-1 p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white/90">
                        <ActionIcon className="size-3 shrink-0 text-white/55" />
                        Step {chapter.index + 1}
                        <span className="text-white/45">·</span>
                        <span className="text-white/60">{action.label}</span>
                    </span>
                    <span className={cn("inline-flex items-center gap-0.5 text-[10px] font-medium", status.text)}>
                        {StatusIcon && <StatusIcon className="size-2.5" />}
                        {status.label}
                    </span>
                </div>
                <p className="line-clamp-1 text-[11px] font-medium text-white/85">{chapter.target}</p>
                {chapter.observation && (
                    <p className="line-clamp-2 text-[11px] leading-snug text-white/55">{chapter.observation}</p>
                )}
            </div>
        </div>
    );
}

function ControlButton({
    label,
    onClick,
    children,
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className="grid size-8 place-items-center rounded-md text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:bg-white/15 focus-visible:outline-none">
            {children}
        </button>
    );
}

export function VideoPlayer({ src, results, label }: { src: string; results: StepResultView[]; label: string }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Tracks the seek-to-end trick used to coax a real duration out of Playwright's webm.
    const probingDuration = useRef(false);

    const [duration, setDuration] = useState(0);
    const [current, setCurrent] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [ready, setReady] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [rate, setRate] = useState(1);
    const [fullscreen, setFullscreen] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [scrubbing, setScrubbing] = useState(false);
    const [hover, setHover] = useState<{ time: number; left: number; chapter: number } | null>(null);

    const chapters = useMemo(() => buildChapters(results, duration), [results, duration]);
    const activeChapter = useMemo(() => chapterAt(chapters, current), [chapters, current]);
    const playedPct = duration > 0 ? (current / duration) * 100 : 0;
    const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;

    const seekTo = useCallback((time: number) => {
        const video = videoRef.current;
        if (!video || !Number.isFinite(time)) {
            return;
        }
        const max = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time;
        const next = clamp(time, 0, max);
        video.currentTime = next;
        setCurrent(next);
    }, []);

    const togglePlay = useCallback(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        if (video.paused) {
            void video.play().catch(() => {});
        } else {
            video.pause();
        }
    }, []);

    const toggleMute = useCallback(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        video.muted = !video.muted;
    }, []);

    const changeVolume = useCallback((value: number) => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        const v = clamp(value, 0, 1);
        video.volume = v;
        video.muted = v === 0;
    }, []);

    const cycleRate = useCallback(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        const idx = PLAYBACK_RATES.indexOf(video.playbackRate as (typeof PLAYBACK_RATES)[number]);
        const nextRate = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length] ?? 1;
        video.playbackRate = nextRate;
    }, []);

    const toggleFullscreen = useCallback(() => {
        const node = containerRef.current;
        if (!node) {
            return;
        }
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
        } else {
            void node.requestFullscreen().catch(() => {});
        }
    }, []);

    // Wire the <video> element's events to React state. One effect keeps the listener
    // set stable; handlers only ever read/set local state.
    useEffect(() => {
        const video = videoRef.current;
        if (!video) {
            return;
        }
        const syncDuration = (): void => {
            if (Number.isFinite(video.duration) && video.duration > 0) {
                setDuration(video.duration);
                setReady(true);
                if (probingDuration.current) {
                    probingDuration.current = false;
                    video.currentTime = 0;
                }
            }
        };
        const onLoadedMetadata = (): void => {
            // Playwright's webm often reports an Infinite duration until forced to scan to
            // the end. Seek far past the end once; the real duration then surfaces.
            if (!Number.isFinite(video.duration) || video.duration <= 0) {
                probingDuration.current = true;
                try {
                    video.currentTime = 1e7;
                } catch {
                    // Some browsers reject the out-of-range seek — duration will arrive later.
                }
            } else {
                syncDuration();
            }
        };
        const onTimeUpdate = (): void => {
            if (!probingDuration.current) {
                setCurrent(video.currentTime);
            }
        };
        // Keep the player usable even if the duration probe never resolves — the video is
        // playable as soon as data arrives, so let the user interact regardless.
        const onLoadedData = (): void => setReady(true);
        const onProgress = (): void => {
            if (video.buffered.length > 0) {
                setBuffered(video.buffered.end(video.buffered.length - 1));
            }
        };
        const onVolume = (): void => {
            setMuted(video.muted);
            setVolume(video.muted ? 0 : video.volume);
        };
        const onRate = (): void => setRate(video.playbackRate);
        const onPlay = (): void => setPlaying(true);
        const onPause = (): void => setPlaying(false);

        video.addEventListener("loadedmetadata", onLoadedMetadata);
        video.addEventListener("durationchange", syncDuration);
        video.addEventListener("loadeddata", onLoadedData);
        video.addEventListener("timeupdate", onTimeUpdate);
        video.addEventListener("progress", onProgress);
        video.addEventListener("volumechange", onVolume);
        video.addEventListener("ratechange", onRate);
        video.addEventListener("play", onPlay);
        video.addEventListener("playing", onPlay);
        video.addEventListener("pause", onPause);

        // The element may already be loaded (remount / warm cache) before listeners attach.
        if (video.readyState >= 1) {
            syncDuration();
        }
        if (video.readyState >= 2) {
            setReady(true);
        } else if (video.readyState === 0) {
            // Chrome sometimes parks a metadata-preload at readyState 0 and never advances
            // until a gesture; kick the load explicitly so the player isn't stuck spinning.
            video.load();
        }
        return () => {
            video.removeEventListener("loadedmetadata", onLoadedMetadata);
            video.removeEventListener("durationchange", syncDuration);
            video.removeEventListener("loadeddata", onLoadedData);
            video.removeEventListener("timeupdate", onTimeUpdate);
            video.removeEventListener("progress", onProgress);
            video.removeEventListener("volumechange", onVolume);
            video.removeEventListener("ratechange", onRate);
            video.removeEventListener("play", onPlay);
            video.removeEventListener("playing", onPlay);
            video.removeEventListener("pause", onPause);
        };
    }, []);

    useEffect(() => {
        const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);

    // Warm the screenshot cache so the timeline's hover previews appear instantly.
    useEffect(() => {
        for (const r of results) {
            if (r.screenshotUrl) {
                const img = new window.Image();
                img.src = r.screenshotUrl;
            }
        }
    }, [results]);

    // Auto-hide the controls while playing and idle; always show them when paused.
    const revealControls = useCallback(() => {
        setControlsVisible(true);
        if (hideTimer.current) {
            clearTimeout(hideTimer.current);
        }
        const video = videoRef.current;
        if (video && !video.paused) {
            hideTimer.current = setTimeout(() => setControlsVisible(false), 2600);
        }
    }, []);

    // Re-evaluate visibility on every play/pause flip: arms the hide timer when playback
    // starts, and forces the controls back on when it pauses.
    useEffect(() => {
        revealControls();
    }, [revealControls, playing]);

    useEffect(
        () => () => {
            if (hideTimer.current) {
                clearTimeout(hideTimer.current);
            }
        },
        [],
    );

    const timeFromPointer = useCallback(
        (clientX: number): { time: number; left: number } => {
            const bar = barRef.current;
            if (!bar || duration <= 0) {
                return { time: 0, left: 0 };
            }
            const rect = bar.getBoundingClientRect();
            const x = clamp(clientX - rect.left, 0, rect.width);
            const ratio = rect.width > 0 ? x / rect.width : 0;
            const left = clamp(x, PREVIEW_WIDTH / 2, rect.width - PREVIEW_WIDTH / 2);
            return { time: ratio * duration, left };
        },
        [duration],
    );

    const updateHover = useCallback(
        (clientX: number) => {
            const { time, left } = timeFromPointer(clientX);
            setHover({ time, left, chapter: chapterAt(chapters, time) });
        },
        [timeFromPointer, chapters],
    );

    const onBarPointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (duration <= 0) {
                return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrubbing(true);
            const { time } = timeFromPointer(e.clientX);
            seekTo(time);
            updateHover(e.clientX);
        },
        [duration, timeFromPointer, seekTo, updateHover],
    );

    const onBarPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            updateHover(e.clientX);
            if (scrubbing) {
                const { time } = timeFromPointer(e.clientX);
                seekTo(time);
            }
        },
        [scrubbing, timeFromPointer, seekTo, updateHover],
    );

    const endScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
        setScrubbing(false);
    }, []);

    const onKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            switch (e.key) {
                case " ":
                case "k":
                    e.preventDefault();
                    togglePlay();
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    seekTo(current + SKIP_SECONDS);
                    break;
                case "ArrowLeft":
                    e.preventDefault();
                    seekTo(current - SKIP_SECONDS);
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    changeVolume(volume + 0.1);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    changeVolume(volume - 0.1);
                    break;
                case "m":
                    toggleMute();
                    break;
                case "f":
                    toggleFullscreen();
                    break;
                default:
                    break;
            }
        },
        [togglePlay, seekTo, current, changeVolume, volume, toggleMute, toggleFullscreen],
    );

    const hoverChapter = hover && hover.chapter >= 0 ? chapters[hover.chapter] : undefined;

    return (
        <div
            ref={containerRef}
            onKeyDown={onKeyDown}
            onPointerMove={(e) => {
                if (e.pointerType !== "touch") {
                    revealControls();
                }
            }}
            onMouseLeave={() => {
                const video = videoRef.current;
                if (video && !video.paused) {
                    setControlsVisible(false);
                }
            }}
            tabIndex={0}
            aria-label={`Recording — ${label}`}
            className={cn(
                "group relative aspect-video w-full select-none bg-[oklch(0.12_0.004_286)] outline-none",
                !controlsVisible && playing && "cursor-none",
            )}>
            {/* preload="auto": these are evidence recordings opened to be watched, so eagerly
                fetch data — it also makes scrubbing instant and avoids a stalled metadata load. */}
            <video
                ref={videoRef}
                src={src}
                preload="auto"
                playsInline
                onClick={togglePlay}
                className="size-full bg-black object-contain"
            />

            {!ready && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <span className="size-7 animate-spin rounded-full border-2 border-white/25 border-t-white/80" />
                </div>
            )}

            {/* Center play affordance while paused. */}
            {ready && !playing && (
                <button
                    type="button"
                    aria-label="Play"
                    onClick={togglePlay}
                    className="absolute inset-0 grid place-items-center focus-visible:outline-none">
                    <span className="grid size-16 place-items-center rounded-full bg-black/55 text-white shadow-lg ring-1 ring-white/15 backdrop-blur-sm transition-transform hover:scale-105">
                        <PlayIcon className="size-7 translate-x-0.5 fill-current" />
                    </span>
                </button>
            )}

            {/* Active-step caption — the "you are here" chapter label. */}
            {activeChapter >= 0 && chapters[activeChapter] && (
                <div
                    className={cn(
                        "pointer-events-none absolute left-3 top-3 max-w-[70%] transition-opacity duration-200",
                        controlsVisible ? "opacity-100" : "opacity-0",
                    )}>
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur-sm ring-1 ring-white/10">
                        <span
                            className={cn(
                                "size-1.5 shrink-0 rounded-full",
                                STATUS_META[chapters[activeChapter].status].marker,
                            )}
                        />
                        <span className="tabular-nums text-white/60">
                            {activeChapter + 1}/{chapters.length}
                        </span>
                        <span className="truncate">{chapters[activeChapter].target}</span>
                    </span>
                </div>
            )}

            {/* Control bar. */}
            <div
                className={cn(
                    "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-3 pb-2 pt-8 transition-opacity duration-200",
                    controlsVisible ? "opacity-100" : "pointer-events-none opacity-0",
                )}>
                {/* Scrubber + hover preview. */}
                <div className="relative">
                    {hover && (
                        <div
                            className="pointer-events-none absolute bottom-full z-10 mb-3"
                            style={{ left: hover.left, width: PREVIEW_WIDTH, transform: "translateX(-50%)" }}>
                            <StepPreview chapter={hoverChapter} time={hover.time} />
                            <span className="mt-1 block text-center font-mono text-[11px] tabular-nums text-white/85">
                                {formatTime(hover.time)}
                            </span>
                        </div>
                    )}

                    <div
                        ref={barRef}
                        role="slider"
                        aria-label="Seek"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(duration)}
                        aria-valuenow={Math.round(current)}
                        aria-valuetext={`${formatTime(current)} of ${formatTime(duration)}`}
                        onPointerDown={onBarPointerDown}
                        onPointerMove={onBarPointerMove}
                        onPointerUp={endScrub}
                        onPointerLeave={() => !scrubbing && setHover(null)}
                        className="group/bar relative flex h-5 cursor-pointer items-center">
                        {/* Track */}
                        <div className="relative h-1 w-full rounded-full bg-white/25 transition-[height] group-hover/bar:h-1.5">
                            <div
                                className="absolute inset-y-0 left-0 rounded-full bg-white/30"
                                style={{ width: `${bufferedPct}%` }}
                            />
                            <div
                                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                                style={{ width: `${playedPct}%` }}
                            />
                        </div>

                        {/* Step markers. */}
                        {chapters.map((c) => {
                            const meta = STATUS_META[c.status];
                            const emphatic = c.status === "failed" || c.status === "blocked";
                            const isActive = c.index === activeChapter;
                            return (
                                <button
                                    key={c.index}
                                    type="button"
                                    aria-label={`Step ${c.index + 1}: ${ACTION_META[c.action].label} ${c.target} — ${meta.label}, ${formatTime(c.start)}`}
                                    title={`Step ${c.index + 1} · ${formatTime(c.start)}`}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        seekTo(c.start);
                                    }}
                                    onPointerEnter={() =>
                                        setHover({
                                            time: c.start,
                                            left: clamp(
                                                duration > 0
                                                    ? (c.start / duration) * (barRef.current?.clientWidth ?? 0)
                                                    : 0,
                                                PREVIEW_WIDTH / 2,
                                                (barRef.current?.clientWidth ?? PREVIEW_WIDTH) - PREVIEW_WIDTH / 2,
                                            ),
                                            chapter: c.index,
                                        })
                                    }
                                    className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 px-1.5 py-2"
                                    style={{ left: `${duration > 0 ? (c.start / duration) * 100 : 0}%` }}>
                                    <span
                                        className={cn(
                                            "block rounded-full ring-1 ring-black/40 transition-all",
                                            meta.marker,
                                            emphatic ? "size-2.5" : "size-2",
                                            isActive && "ring-2 ring-white/80",
                                            !isActive && "opacity-80 group-hover/bar:opacity-100",
                                        )}
                                    />
                                </button>
                            );
                        })}

                        {/* Playhead knob. */}
                        <span
                            className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow ring-2 ring-white/90 transition-transform group-hover/bar:scale-110"
                            style={{ left: `${playedPct}%` }}
                        />
                    </div>
                </div>

                {/* Buttons row. */}
                <div className="mt-1 flex items-center gap-1">
                    <ControlButton label={playing ? "Pause" : "Play"} onClick={togglePlay}>
                        {playing ? (
                            <PauseIcon className="size-4 fill-current" />
                        ) : (
                            <PlayIcon className="size-4 fill-current" />
                        )}
                    </ControlButton>

                    <div className="group/vol flex items-center">
                        <ControlButton label={muted || volume === 0 ? "Unmute" : "Mute"} onClick={toggleMute}>
                            {muted || volume === 0 ? (
                                <VolumeXIcon className="size-4" />
                            ) : (
                                <Volume2Icon className="size-4" />
                            )}
                        </ControlButton>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={muted ? 0 : volume}
                            aria-label="Volume"
                            onChange={(e) => changeVolume(Number(e.target.value))}
                            className="h-1 w-0 cursor-pointer accent-primary opacity-0 transition-all duration-200 group-hover/vol:ml-1 group-hover/vol:w-16 group-hover/vol:opacity-100"
                        />
                    </div>

                    <span className="ml-1 font-mono text-xs tabular-nums text-white/85">
                        {formatTime(current)} <span className="text-white/45">/ {formatTime(duration)}</span>
                    </span>

                    <div className="ml-auto flex items-center gap-1">
                        <button
                            type="button"
                            aria-label="Playback speed"
                            title="Playback speed"
                            onClick={cycleRate}
                            className="grid h-8 min-w-9 place-items-center rounded-md px-1.5 font-mono text-xs font-medium text-white/85 transition-colors hover:bg-white/15 hover:text-white focus-visible:bg-white/15 focus-visible:outline-none">
                            {rate}×
                        </button>
                        <ControlButton
                            label={fullscreen ? "Exit full screen" : "Full screen"}
                            onClick={toggleFullscreen}>
                            {fullscreen ? <MinimizeIcon className="size-4" /> : <MaximizeIcon className="size-4" />}
                        </ControlButton>
                    </div>
                </div>
            </div>
        </div>
    );
}
