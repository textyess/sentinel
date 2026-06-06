// Sentinel dashboard — vanilla ES module, no build step.

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") node.className = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
}

async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
    return data;
}

const splitList = (s) =>
    (s || "")
        .split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean);

// ---- health ----------------------------------------------------------------

async function refreshHealth() {
    const host = $("#health");
    try {
        const h = await api("/api/health");
        host.replaceChildren(
            pill("GitHub", h.ghAuthOk),
            pill("LLM", h.llmCredOk),
            pill("Poller", h.pollerRunning),
        );
    } catch {
        host.replaceChildren(pill("server", false));
    }
}

function pill(label, ok) {
    return el("span", { class: `pill ${ok ? "ok" : "bad"}` }, el("span", { class: "dot" }), label);
}

// ---- projects ---------------------------------------------------------------

async function loadProjects() {
    const host = $("#projects");
    try {
        const projects = await api("/api/projects");
        if (!projects.length) {
            host.replaceChildren(el("div", { class: "empty" }, "No projects yet — add a GitHub repo to start."));
            return;
        }
        host.replaceChildren(...projects.map(projectCard));
    } catch (e) {
        host.replaceChildren(el("div", { class: "empty error" }, String(e.message)));
    }
}

function projectCard(p) {
    const prInput = el("input", { type: "number", min: "1", placeholder: "PR #" });
    const verifyBtn = el(
        "button",
        {
            onclick: async () => {
                const pr = Number.parseInt(prInput.value, 10);
                if (!pr) return;
                verifyBtn.disabled = true;
                try {
                    const { runId } = await api(`/api/projects/${encodeURIComponent(p.id)}/verify/${pr}`, {
                        method: "POST",
                    });
                    openLive(runId, `${p.repo} #${pr}`);
                } catch (e) {
                    alert(e.message);
                } finally {
                    verifyBtn.disabled = false;
                }
            },
        },
        "Verify",
    );

    const baselineInput = el("input", { type: "url", placeholder: "Baseline URL (to crawl)" });
    baselineInput.value = p.baselineUrl || "";
    const saveBaselineBtn = el(
        "button",
        {
            class: "ghost",
            onclick: async () => {
                saveBaselineBtn.disabled = true;
                try {
                    await api(`/api/projects/${encodeURIComponent(p.id)}`, {
                        method: "PATCH",
                        body: JSON.stringify({ baselineUrl: baselineInput.value.trim() || null }),
                    });
                    loadProjects();
                } catch (e) {
                    alert(e.message);
                } finally {
                    saveBaselineBtn.disabled = false;
                }
            },
        },
        "Save URL",
    );
    const crawlBtn = el(
        "button",
        {
            title: "Crawls this project's Baseline URL (or SENTINEL_BASE_URL) to build the map",
            onclick: async () => {
                crawlBtn.disabled = true;
                try {
                    const { runId } = await api(`/api/projects/${encodeURIComponent(p.id)}/crawl`, {
                        method: "POST",
                        body: JSON.stringify({}),
                    });
                    openLive(runId, `${p.repo} — baseline crawl`, "crawl");
                } catch (e) {
                    alert(e.message);
                } finally {
                    crawlBtn.disabled = false;
                }
            },
        },
        p.graphPresent ? "Re-crawl" : "Build baseline",
    );

    const ready = p.graphPresent && p.credsConfigured;
    return el(
        "div",
        { class: "card project" },
        el(
            "div",
            {},
            el("div", { class: "repo" }, p.repo),
            el("div", { class: "meta" }, `${p.adapterKind} · mentions ${p.mentionHandle} · preview "${p.previewEnvIncludes}"`),
            el(
                "div",
                { class: "badges" },
                badge("baseline graph", p.graphPresent, p.graphPresent ? "present" : "needs crawl"),
                badge("credentials", p.credsConfigured, p.credsConfigured ? "set" : "missing"),
            ),
        ),
        el("div", { class: "verify-row" }, baselineInput, saveBaselineBtn, crawlBtn),
        el(
            "div",
            { class: "verify-row" },
            prInput,
            verifyBtn,
            el(
                "button",
                {
                    class: "ghost",
                    onclick: async () => {
                        if (!confirm(`Remove ${p.repo}?`)) return;
                        await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
                        loadProjects();
                    },
                },
                "Remove",
            ),
            !ready ? el("span", { class: "meta" }, "auto-verify paused") : null,
        ),
    );
}

function badge(label, ok, value) {
    return el("span", { class: `badge ${ok ? "ok" : "warn"}` }, `${label}: ${value}`);
}

// ---- registration form ------------------------------------------------------

function setupForm() {
    const form = $("#project-form");
    form.innerHTML = `
        <div class="grid-2">
            <div><label>Repo (owner/name)</label><input name="repo" placeholder="acme/web" required /></div>
            <div><label>Adapter</label><select name="adapterKind"><option value="generic">generic</option></select></div>
        </div>
        <div class="grid-2">
            <div><label>Preview env contains</label><input name="previewEnvIncludes" value="web" /></div>
            <div><label>Mention handle</label><input name="mentionHandle" value="@sentinel" /></div>
        </div>
        <div><label>Baseline URL (optional — the app Sentinel crawls; verify uses the PR preview)</label><input name="baselineUrl" placeholder="https://app.example.com" /></div>
        <fieldset class="generic-only">
            <legend>Generic app config</legend>
            <div class="grid-2">
                <div><label>Login path</label><input name="loginPath" value="/login" /></div>
                <div><label>Authenticated URL pattern</label><input name="authenticatedUrlPattern" value="/" /></div>
            </div>
            <div class="grid-2">
                <div><label>Email field label</label><input name="emailLabel" value="Email" /></div>
                <div><label>Password field label</label><input name="passwordLabel" value="Password" /></div>
            </div>
            <div class="grid-2">
                <div><label>Submit button pattern</label><input name="submitNamePattern" value="log\\s*in" /></div>
                <div><label>Pages prefix (optional)</label><input name="pagesPrefix" placeholder="app/ or src/pages/" /></div>
            </div>
            <div class="grid-2">
                <div><label>Email env var name</label><input name="emailEnv" placeholder="SENTINEL_PROJECT_EMAIL" /></div>
                <div><label>Password env var name</label><input name="passwordEnv" placeholder="SENTINEL_PROJECT_PASSWORD" /></div>
            </div>
            <div><label>Public routes (comma)</label><input name="publicRoutes" value="/login" /></div>
            <div><label>Allowed mutation patterns (comma — auth only)</label><input name="allowedMutationPatterns" value="^/login$" /></div>
        </fieldset>
        <div class="form-actions"><button class="primary" type="submit">Register</button><span class="error" id="form-error"></span></div>
    `;

    const kind = form.elements.adapterKind;
    const genericBlock = form.querySelector(".generic-only");
    const syncKind = () => {
        genericBlock.classList.toggle("hidden", kind.value !== "generic");
    };
    kind.addEventListener("change", syncKind);
    syncKind();

    // Populate the adapter dropdown from the registry (generic + any built-ins).
    api("/api/adapters")
        .then((d) => {
            const kinds = d && Array.isArray(d.kinds) && d.kinds.length ? d.kinds : ["generic"];
            kind.innerHTML = kinds.map((k) => `<option value="${k}">${k}</option>`).join("");
            syncKind();
        })
        .catch(() => {});

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const err = $("#form-error");
        err.textContent = "";
        const f = form.elements;
        const body = {
            repo: f.repo.value.trim(),
            adapterKind: f.adapterKind.value,
            previewEnvIncludes: f.previewEnvIncludes.value.trim() || "web",
            mentionHandle: f.mentionHandle.value.trim() || "@sentinel",
            baselineUrl: f.baselineUrl.value.trim() || null,
            adapter: null,
        };
        if (body.adapterKind === "generic") {
            body.adapter = {
                auth: {
                    loginPath: f.loginPath.value.trim(),
                    emailLabel: f.emailLabel.value.trim(),
                    passwordLabel: f.passwordLabel.value.trim(),
                    submitNamePattern: f.submitNamePattern.value.trim(),
                    authenticatedUrlPattern: f.authenticatedUrlPattern.value.trim(),
                    publicRoutes: splitList(f.publicRoutes.value),
                },
                emailEnv: f.emailEnv.value.trim(),
                passwordEnv: f.passwordEnv.value.trim(),
                previewEnvIncludes: body.previewEnvIncludes,
                pagesPrefix: f.pagesPrefix.value.trim() || undefined,
                allowedMutationPatterns: splitList(f.allowedMutationPatterns.value),
            };
        }
        try {
            await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
            form.reset();
            syncKind();
            form.classList.add("hidden");
            loadProjects();
        } catch (e2) {
            err.textContent = e2.message;
        }
    });

    $("#toggle-form").addEventListener("click", () => form.classList.toggle("hidden"));
}

// ---- gallery ----------------------------------------------------------------

async function loadRuns() {
    const host = $("#gallery");
    try {
        const runs = await api("/api/runs");
        $("#gallery-count").textContent = runs.length ? `${runs.length} run(s)` : "";
        if (!runs.length) {
            host.replaceChildren(el("div", { class: "empty" }, "No runs yet. Tag Sentinel on a PR, or trigger one above."));
            return;
        }
        host.replaceChildren(...runs.map(runCard));
    } catch (e) {
        host.replaceChildren(el("div", { class: "empty error" }, String(e.message)));
    }
}

function runCard(r) {
    const media = r.videoUrl
        ? el("video", { controls: "", preload: "metadata", src: r.videoUrl })
        : el("div", { class: "novideo" }, r.status === "running" ? "recording…" : "no recording");

    const prLink = r.repo.includes("/")
        ? el("a", { href: `https://github.com/${r.repo}/pull/${r.pr}`, target: "_blank", rel: "noreferrer" }, `#${r.pr} ↗`)
        : el("span", { class: "meta" }, `#${r.pr}`);

    const dismissBtn = el(
        "button",
        {
            class: "ghost dismiss",
            title: "Remove this run from the gallery",
            onclick: async () => {
                if (!confirm("Remove this run?")) return;
                try {
                    await api(`/api/runs/${encodeURIComponent(r.runId)}`, { method: "DELETE" });
                    loadRuns();
                } catch (e) {
                    alert(e.message);
                }
            },
        },
        "✕",
    );

    return el(
        "div",
        { class: "card run" },
        media,
        el(
            "div",
            { class: "run-body" },
            el(
                "div",
                { class: "run-title" },
                el("span", { class: `verdict ${r.status}` }, r.outcome || r.status),
                prLink,
                dismissBtn,
            ),
            el("h3", {}, r.title || `PR #${r.pr}`),
            el("div", { class: "meta" }, r.repo),
            r.summary ? el("p", { class: "summary" }, r.summary) : null,
        ),
    );
}

// ---- live run ---------------------------------------------------------------

const VERIFY_PHASES = [
    { key: "Plan", match: /Planning with/i },
    { key: "Target", match: /^Target:/ },
    { key: "Auth", match: /Authenticating/i },
    { key: "Steps", match: /step \d+\/\d+/i },
    { key: "Judge", match: /Judging/i },
    { key: "Verdict", match: /^never$/ },
];
const CRAWL_PHASES = [
    { key: "Auth", match: /Authenticating/i },
    { key: "Crawl", match: /Crawling/i },
    { key: "Mapped", match: /Mapped \d/i },
];

let liveSource = null;

function renderChips(phases, activeIdx) {
    const host = $("#live-chips");
    host.replaceChildren(
        ...phases.map((p, i) =>
            el("span", { class: `chip ${i < activeIdx ? "done" : i === activeIdx ? "active" : ""}` }, p.key),
        ),
    );
}

function openLive(runId, label, kind = "verify") {
    if (liveSource) liveSource.close();
    const phases = kind === "crawl" ? CRAWL_PHASES : VERIFY_PHASES;
    const panel = $("#live");
    panel.classList.remove("hidden");
    $("#live-verdict").replaceChildren();
    const log = $("#live-log");
    log.textContent = `▶ ${label}\n`;
    renderChips(phases, 0);
    let phaseIdx = 0;

    const src = new EventSource(`/api/events?runId=${encodeURIComponent(runId)}`);
    liveSource = src;

    src.addEventListener("progress", (ev) => {
        const { level, message } = JSON.parse(ev.data);
        log.textContent += `${level === "error" ? "✖ " : level === "success" ? "✓ " : "· "}${message}\n`;
        log.scrollTop = log.scrollHeight;
        phases.forEach((p, i) => {
            if (i > phaseIdx && p.match.test(message)) phaseIdx = i;
        });
        renderChips(phases, phaseIdx);
    });

    src.addEventListener("done", (ev) => {
        const data = JSON.parse(ev.data);
        renderChips(phases, phases.length);
        if (data.kind === "crawl") {
            const c = data.coverage;
            $("#live-verdict").replaceChildren(
                el(
                    "div",
                    { class: "card" },
                    el("span", { class: "verdict passed" }, "baseline ready"),
                    el(
                        "p",
                        { class: "summary" },
                        ` Mapped ${c.nodeCount} page state(s), ${c.edgeCount} navigation edge(s); ${c.routesReached} route(s) reached, ${c.routesUnreached} seeded route(s) not reached.`,
                    ),
                ),
            );
        } else {
            const { verdict, videoUrl } = data;
            const status = verdict.outcome === "pass" ? "passed" : verdict.outcome === "fail" ? "failed" : "uncertain";
            $("#live-verdict").replaceChildren(
                el(
                    "div",
                    { class: "card" },
                    el("span", { class: `verdict ${status}` }, verdict.outcome),
                    el("p", { class: "summary" }, ` ${verdict.summary}`),
                    videoUrl ? el("video", { controls: "", preload: "metadata", src: videoUrl }) : null,
                ),
            );
        }
        src.close();
        liveSource = null;
        loadRuns();
        loadProjects();
    });

    src.addEventListener("error", (ev) => {
        if (ev.data) {
            try {
                log.textContent += `✖ ${JSON.parse(ev.data).message}\n`;
            } catch {
                // browser-level connection error event (no data); ignore
            }
        }
    });
}

$("#live-close").addEventListener("click", () => {
    if (liveSource) liveSource.close();
    liveSource = null;
    $("#live").classList.add("hidden");
});

// ---- settings panel ---------------------------------------------------------

const CONFIG_FIELDS = [
    { key: "SENTINEL_BASE_URL", label: "Base URL (default crawl target)", type: "url" },
    { key: "SENTINEL_LLM_PROVIDER", label: "LLM provider", type: "select", options: ["anthropic", "openai", "bedrock"] },
    { key: "SENTINEL_LLM_MODEL", label: "LLM model (optional)", type: "text" },
    { key: "AWS_REGION", label: "AWS region", type: "text" },
    { key: "SENTINEL_HEADLESS", label: "Headless browser", type: "select", options: ["true", "false"] },
];
const SECRET_FIELDS = [
    { key: "SENTINEL_EMAIL", label: "Login email" },
    { key: "SENTINEL_PASSWORD", label: "Login password" },
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API key" },
    { key: "OPENAI_API_KEY", label: "OpenAI API key" },
    { key: "AWS_ACCESS_KEY_ID", label: "AWS access key id" },
    { key: "AWS_SECRET_ACCESS_KEY", label: "AWS secret access key" },
];

async function openSettings() {
    const panel = $("#settings");
    let env;
    try {
        env = await api("/api/env");
    } catch (e) {
        panel.replaceChildren(el("div", { class: "error" }, e.message));
        return;
    }

    const known = new Set([...CONFIG_FIELDS, ...SECRET_FIELDS].map((f) => f.key));
    const extraSecretKeys = Object.keys(env.keys).filter((k) => !known.has(k));
    const inputs = new Map();

    const configRows = CONFIG_FIELDS.map((f) => {
        const input =
            f.type === "select"
                ? el("select", {}, ...f.options.map((o) => el("option", { value: o }, o)))
                : el("input", { type: f.type === "url" ? "url" : "text" });
        input.value = env.values[f.key] ?? "";
        inputs.set(f.key, { input, secret: false });
        return el("div", {}, el("label", {}, f.label), input);
    });

    const secretRow = (f) => {
        const isSet = Boolean(env.keys[f.key]?.set);
        const input = el("input", {
            type: "password",
            placeholder: isSet ? "•••• set — leave blank to keep" : "not set",
        });
        const clear = el(
            "button",
            {
                type: "button",
                class: "ghost",
                onclick: () => {
                    input.dataset.clear = "1";
                    input.value = "";
                    input.placeholder = "will be cleared on save";
                },
            },
            "Clear",
        );
        inputs.set(f.key, { input, secret: true });
        return el(
            "div",
            {},
            el("label", {}, f.label, " ", el("span", { class: `badge ${isSet ? "ok" : "warn"}` }, isSet ? "set" : "unset")),
            el("div", { class: "secret-row" }, input, isSet ? clear : null),
        );
    };

    const secretRows = [...SECRET_FIELDS, ...extraSecretKeys.map((k) => ({ key: k, label: k }))].map(secretRow);

    const err = el("span", { class: "error" });
    const saveBtn = el(
        "button",
        {
            class: "primary",
            type: "button",
            onclick: async () => {
                err.textContent = "";
                saveBtn.disabled = true;
                const updates = {};
                for (const [key, { input, secret }] of inputs) {
                    if (secret) {
                        if (input.dataset.clear === "1") updates[key] = "";
                        else if (input.value !== "") updates[key] = input.value;
                        // blank + not cleared → keep the existing secret
                    } else {
                        updates[key] = input.value.trim();
                    }
                }
                try {
                    await api("/api/env", { method: "PUT", body: JSON.stringify({ updates }) });
                    await refreshHealth();
                    await loadProjects();
                    await openSettings();
                } catch (e) {
                    err.textContent = e.message;
                } finally {
                    saveBtn.disabled = false;
                }
            },
        },
        "Save settings",
    );

    panel.replaceChildren(
        el(
            "div",
            { class: "section-head" },
            el("h2", {}, "Settings"),
            el("span", { class: "muted" }, "Applied to the running agent + saved to .env (also used by the CLI)"),
        ),
        el("div", { class: "grid-2" }, ...configRows),
        ...secretRows,
        el("div", { class: "form-actions" }, saveBtn, err),
    );
}

$("#toggle-settings").addEventListener("click", () => {
    const panel = $("#settings");
    const nowHidden = panel.classList.toggle("hidden");
    if (!nowHidden) openSettings();
});

// ---- boot -------------------------------------------------------------------

setupForm();
refreshHealth();
loadProjects();
loadRuns();
setInterval(loadRuns, 5000);
setInterval(refreshHealth, 15000);
