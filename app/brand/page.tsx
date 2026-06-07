"use client";

import { Shantell_Sans } from "next/font/google";
import { EyeMark } from "@/components/brand/eye-mark";
import { cn } from "@/lib/utils";
import styles from "./brand.module.css";

// The wordmark's casual marker hand — the one web-font dependency in the brand.
// Variable font, so no explicit weights; the wordmark uses 700 via CSS.
const shantell = Shantell_Sans({ subsets: ["latin"], variable: "--font-shantell", display: "swap" });

function Word({ size = 44, dark = false }: { size?: number; dark?: boolean }) {
    return (
        <span className={cn(styles.wm, dark && styles.wmDark)} style={{ fontSize: size }}>
            Sentinel
        </span>
    );
}

const FAVICON_SIZES = [64, 48, 32, 24, 16];

const BRAND_FILES = [
    { name: "sentinel-eye.svg", desc: "primary mark, black" },
    { name: "sentinel-eye-dark.svg", desc: "inverted — cream, transparent bg" },
    { name: "sentinel-favicon.svg", desc: "bare eye for ≤32px, black" },
    { name: "sentinel-favicon-dark.svg", desc: "bare eye, cream" },
];

export default function BrandPage() {
    return (
        <div className={cn(styles.page, shantell.variable)}>
            <div className={styles.wrap}>
                <div className={styles.eyebrow}>Sentinel · brand · v1</div>
                <div className={styles.lockH} style={{ marginBottom: "1.6rem" }}>
                    <EyeMark size={86} className={styles.eyeInk} />
                    <Word size={56} />
                </div>
                <h1>The eye that watches your browser.</h1>
                <p className={styles.lede}>
                    A sentinel for your pull requests — it learns the codebase, drives the app in a real browser, and
                    films what it sees. The mark is that eye, drawn by hand, with a single spark for the moment it
                    notices something.
                </p>
                <hr className={styles.headRule} />

                {/* THE MARK */}
                <section>
                    <h2>The mark</h2>
                    <p className={styles.h2sub}>Two primary colorways — black on paper, and inverted for dark UI.</p>
                    <div className={styles.pair}>
                        <div className={cn(styles.panel, styles.panelLight)}>
                            <EyeMark size={200} className={styles.eyeInk} />
                            <span className={styles.ptag}>Black · #111 on #fdfdfb</span>
                        </div>
                        <div className={cn(styles.panel, styles.panelDark)}>
                            <EyeMark size={200} className={styles.eyeCream} />
                            <span className={styles.ptag}>Inverted · #f3f1ea on #141414</span>
                        </div>
                    </div>
                </section>

                {/* LOCKUPS */}
                <section>
                    <h2>Lockups</h2>
                    <p className={styles.h2sub}>
                        Hand-drawn wordmark (Shantell Sans). Horizontal is primary; stacked for square spaces.
                    </p>
                    <div className={styles.lockrow}>
                        <div className={styles.lockbox}>
                            <div className={styles.lockH}>
                                <EyeMark size={66} className={styles.eyeInk} />
                                <Word size={40} />
                            </div>
                            <span className={styles.cap}>Horizontal · primary</span>
                        </div>
                        <div className={cn(styles.lockbox, styles.lockboxDark)}>
                            <div className={styles.lockH}>
                                <EyeMark size={66} className={styles.eyeCream} />
                                <Word size={40} dark />
                            </div>
                            <span className={styles.cap}>Horizontal · dark</span>
                        </div>
                        <div className={styles.lockbox}>
                            <div className={styles.lockV} style={{ width: "100%" }}>
                                <EyeMark size={92} className={styles.eyeInk} />
                                <Word size={34} />
                            </div>
                            <span className={styles.cap}>Stacked</span>
                        </div>
                        <div className={styles.lockbox}>
                            <div className={styles.lockV} style={{ width: "100%", alignItems: "flex-start" }}>
                                <Word size={48} />
                            </div>
                            <span className={styles.cap}>Wordmark only</span>
                        </div>
                    </div>
                </section>

                {/* SMALL SIZES */}
                <section>
                    <h2>Small sizes &amp; favicon</h2>
                    <p className={styles.h2sub}>
                        At ≤32px the spark is dropped — the bare eye stays legible. This is the favicon / avatar mark.
                    </p>
                    <div className={styles.favgrid}>
                        {FAVICON_SIZES.map((s) => (
                            <div className={styles.favcell} key={s}>
                                <EyeMark size={s} withSpark={false} className={styles.eyeInk} />
                                <span className={styles.px}>{s}px</span>
                            </div>
                        ))}
                    </div>
                    <div className={cn(styles.favgrid, styles.favgridDark)} style={{ marginTop: 18 }}>
                        {FAVICON_SIZES.map((s) => (
                            <div className={styles.favcell} key={s}>
                                <EyeMark size={s} withSpark={false} className={styles.eyeCream} />
                                <span className={styles.px}>{s}px</span>
                            </div>
                        ))}
                    </div>
                </section>

                {/* CLEARSPACE */}
                <section>
                    <h2>Clear space</h2>
                    <p className={styles.h2sub}>
                        Keep free space around the mark equal to the height of the pupil. Don't crowd it.
                    </p>
                    <div className={styles.clear}>
                        <div className={styles.clearbox}>
                            <EyeMark size={140} className={styles.eyeInk} />
                        </div>
                    </div>
                </section>

                {/* RULES */}
                <section>
                    <h2>A few rules</h2>
                    <p className={styles.h2sub}>The mark is hand-drawn and quiet. Keep it that way.</p>
                    <div className={styles.grid2}>
                        <div className={cn(styles.ruleItem, styles.ruleDo)}>
                            <p className={styles.k}>Do</p>
                            <p>
                                Use the spark version for hero / favicon-large; the bare eye for ≤32px. Pair with the
                                serif body voice.
                            </p>
                        </div>
                        <div className={cn(styles.ruleItem, styles.ruleDont)}>
                            <p className={styles.k}>Don't</p>
                            <p>
                                Add gradients, drop-shadows, or a second accent color. Outline strokes are uniform —
                                never taper them.
                            </p>
                        </div>
                        <div className={cn(styles.ruleItem, styles.ruleDo)}>
                            <p className={styles.k}>Do</p>
                            <p>Place on #fdfdfb paper or #141414 dark. Give it room equal to the pupil height.</p>
                        </div>
                        <div className={cn(styles.ruleItem, styles.ruleDont)}>
                            <p className={styles.k}>Don't</p>
                            <p>
                                Recolor the mark. The inverted version is a single cream ink on dark — spark included.
                                No rounded boxes behind it.
                            </p>
                        </div>
                    </div>
                </section>

                {/* FILES */}
                <section>
                    <h2>
                        Files in <code>/brand</code>
                    </h2>
                    <p className={styles.h2sub}>Drop-in SVGs. Scalable, no font dependency on the marks themselves.</p>
                    <ul className={styles.files}>
                        {BRAND_FILES.map((f) => (
                            <li key={f.name}>
                                <span>{f.name}</span>
                                <span className={styles.desc}>{f.desc}</span>
                            </li>
                        ))}
                    </ul>
                    <p className={styles.h2sub} style={{ marginTop: "1.4rem" }}>
                        Wordmark font: <strong>Shantell Sans</strong> (700) — open-licensed, loaded from Google Fonts.
                        The lockup is the mark SVG + live text; export to PNG if you need it baked.
                    </p>
                </section>

                <p className={styles.colophon}>
                    Sentinel · an open-source agent that tests pull requests in the browser · drawn in the WybieLabs ink
                    palette
                </p>
            </div>
        </div>
    );
}
