import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Sentinel's mark — the eye that watches your browser. Bold hand-drawn line-art:
 * clean SVG geometry pushed through an feDisplacementMap "roughen" filter so the
 * strokes wobble like a thick marker.
 *
 * The whole mark — outline, iris, and spark — inherits `currentColor`, so it
 * renders monochrome: ink #111 on paper, white/cream on dark. Geometry, stroke,
 * and filter mirror /brand/sentinel-eye.svg exactly. Drop the spark
 * (`withSpark={false}`) below ~32px — the bare eye stays legible where the
 * accents would muddy.
 */
export function EyeMark({
    size = 32,
    withSpark = true,
    className,
    title = "Sentinel",
}: {
    size?: number;
    withSpark?: boolean;
    className?: string;
    title?: string;
}) {
    // Per-instance filter id — multiple marks on one page must not share a filter.
    const rough = `sentinel-rough-${useId().replace(/:/g, "")}`;
    return (
        <svg
            viewBox="0 0 200 200"
            width={size}
            height={size}
            className={cn("text-foreground", className)}
            role="img"
            aria-label={title}>
            <defs>
                <filter id={rough} x="-25%" y="-25%" width="150%" height="150%">
                    <feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="2" seed="11" result="n" />
                    <feDisplacementMap
                        in="SourceGraphic"
                        in2="n"
                        scale="4.2"
                        xChannelSelector="R"
                        yChannelSelector="G"
                    />
                </filter>
            </defs>
            <g
                filter={`url(#${rough})`}
                fill="none"
                stroke="currentColor"
                strokeWidth={13}
                strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M 16 102 Q 100 44 184 102 Q 100 160 16 102 Z" />
                <circle cx="100" cy="102" r="31" />
                <circle cx="100" cy="102" r="11" fill="currentColor" stroke="none" />
                {withSpark && (
                    <>
                        <path
                            d="M 165 37 Q 165 52 180 52 Q 165 52 165 67 Q 165 52 150 52 Q 165 52 165 37 Z"
                            fill="currentColor"
                            stroke="none"
                        />
                        <path d="M 186 73.5 L 192.5 80 L 186 86.5 L 179.5 80 Z" fill="currentColor" stroke="none" />
                    </>
                )}
            </g>
        </svg>
    );
}
