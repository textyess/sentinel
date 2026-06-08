#!/usr/bin/env node
// Validate + normalize a Sentinel project config (the POST /api/projects body) BEFORE
// `sentinel register`, mirroring the server's Zod rules so mistakes surface immediately.
//
// Usage:
//   node build-config.mjs --in draft.json > project.json
//   cat draft.json | node build-config.mjs > project.json
//
// Reads a draft JSON, applies the same guards the registry enforces (repo is owner/name;
// auth regexes compile; every allowedMutationPatterns entry is ^-anchored and compiles;
// a public app has an empty allow-list), fills credential env-var NAMES from the repo slug,
// and prints the normalized config to stdout. Exits non-zero with a clear message on error.

import { readFileSync } from "node:fs";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

function die(message) {
    process.stderr.write(`build-config: ${message}\n`);
    process.exit(1);
}

function warn(message) {
    process.stderr.write(`build-config: warning: ${message}\n`);
}

function slug(repo) {
    return repo
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function credEnvNames(repo) {
    const base = slug(repo).replace(/-/g, "_").toUpperCase() || "PROJECT";
    return { emailEnv: `SENTINEL_${base}_EMAIL`, passwordEnv: `SENTINEL_${base}_PASSWORD` };
}

function compiles(source) {
    try {
        // eslint-disable-next-line no-new
        new RegExp(source);
        return true;
    } catch {
        return false;
    }
}

function readInput() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        process.stdout.write(
            "Usage: node build-config.mjs --in draft.json > project.json (or pipe JSON via stdin)\n",
        );
        process.exit(0);
    }
    const i = argv.indexOf("--in");
    const path = i >= 0 ? argv[i + 1] : null;
    try {
        const raw = path ? readFileSync(path, "utf8") : readFileSync(0, "utf8");
        if (!raw.trim()) {
            die("no input — pass --in <file> or pipe JSON via stdin");
        }
        return JSON.parse(raw);
    } catch (error) {
        if (error && error.code === "ENOENT") {
            die(`no file at ${path}`);
        }
        die(`input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function requireString(obj, field, where) {
    const value = obj?.[field];
    if (typeof value !== "string" || value.trim() === "") {
        die(`${where}.${field} is required and must be a non-empty string`);
    }
    return value;
}

const input = readInput();

const repo = requireString(input, "repo", "config");
if (!REPO_RE.test(repo)) {
    die(`repo must be "owner/name" (got ${JSON.stringify(repo)})`);
}

const adapterKind = input.adapterKind ?? "generic";
if (adapterKind !== "generic") {
    // The helper only assembles the no-code generic path; built-ins are code, not config.
    die(`adapterKind "${adapterKind}" is not supported here — only "generic" (use a bespoke adapter for built-ins)`);
}

const a = input.adapter;
if (!a || typeof a !== "object") {
    die('a generic project requires an "adapter" object');
}

// --- auth ---
const auth = a.auth;
if (!auth || typeof auth !== "object") {
    die("adapter.auth is required");
}
const loginPath = requireString(auth, "loginPath", "adapter.auth");
const emailLabel = requireString(auth, "emailLabel", "adapter.auth");
const passwordLabel = requireString(auth, "passwordLabel", "adapter.auth");
const submitNamePattern = requireString(auth, "submitNamePattern", "adapter.auth");
const authenticatedUrlPattern = requireString(auth, "authenticatedUrlPattern", "adapter.auth");
if (!compiles(submitNamePattern)) {
    die(`adapter.auth.submitNamePattern is not a valid regex: ${submitNamePattern}`);
}
if (!compiles(authenticatedUrlPattern)) {
    die(`adapter.auth.authenticatedUrlPattern is not a valid regex: ${authenticatedUrlPattern}`);
}
const publicRoutes = Array.isArray(auth.publicRoutes) ? auth.publicRoutes : [];

const authRequired = a.authRequired ?? true;
if (typeof authRequired !== "boolean") {
    die("adapter.authRequired must be a boolean");
}

// --- allowedMutationPatterns (the safety-critical field) ---
let allowed = Array.isArray(a.allowedMutationPatterns) ? a.allowedMutationPatterns : [];
for (const p of allowed) {
    if (typeof p !== "string" || !p.startsWith("^")) {
        die(`each allowedMutationPatterns entry must be a string anchored with ^ (auth paths only): ${JSON.stringify(p)}`);
    }
    if (!compiles(p)) {
        die(`allowedMutationPatterns entry is not a valid regex: ${p}`);
    }
}
if (!authRequired && allowed.length > 0) {
    warn("public app (authRequired:false) — forcing allowedMutationPatterns to [] (no auth POST to permit)");
    allowed = [];
}

// --- credentials by NAME (never secrets) ---
const derived = credEnvNames(repo);
const emailEnv = a.emailEnv || derived.emailEnv;
const passwordEnv = a.passwordEnv || derived.passwordEnv;
for (const [k, v] of [["emailEnv", emailEnv], ["passwordEnv", passwordEnv]]) {
    if (!KEY_RE.test(v)) {
        die(`${k} must be an ENV_VAR name matching /^[A-Z][A-Z0-9_]*$/ (got ${JSON.stringify(v)})`);
    }
}

// --- pagesPrefix (optional, non-fatal hygiene) ---
const pagesPrefix = a.pagesPrefix;
if (pagesPrefix !== undefined) {
    if (typeof pagesPrefix !== "string") {
        die("adapter.pagesPrefix must be a string");
    }
    if (pagesPrefix && !pagesPrefix.endsWith("/")) {
        warn(`pagesPrefix "${pagesPrefix}" has no trailing slash — it is matched with startsWith and may over-match siblings`);
    }
}

// --- optional regex arrays ---
for (const field of ["productionMarkers", "destructiveControlPatterns"]) {
    const arr = a[field];
    if (arr === undefined) {
        continue;
    }
    if (!Array.isArray(arr)) {
        die(`adapter.${field} must be an array of regex strings`);
    }
    for (const p of arr) {
        if (typeof p !== "string" || !compiles(p)) {
            die(`adapter.${field} entry is not a valid regex: ${JSON.stringify(p)}`);
        }
    }
}

const previewEnvIncludes = (typeof a.previewEnvIncludes === "string" && a.previewEnvIncludes) || "web";

const normalized = {
    repo,
    adapterKind: "generic",
    previewEnvIncludes: (typeof input.previewEnvIncludes === "string" && input.previewEnvIncludes) || previewEnvIncludes,
    mentionHandle: (typeof input.mentionHandle === "string" && input.mentionHandle) || "@sentinel",
    ...(typeof input.baselineUrl === "string" ? { baselineUrl: input.baselineUrl } : {}),
    adapter: {
        auth: {
            loginPath,
            emailLabel,
            passwordLabel,
            submitNamePattern,
            authenticatedUrlPattern,
            ...(typeof auth.emailFallbackSelector === "string"
                ? { emailFallbackSelector: auth.emailFallbackSelector }
                : {}),
            ...(typeof auth.passwordFallbackSelector === "string"
                ? { passwordFallbackSelector: auth.passwordFallbackSelector }
                : {}),
            publicRoutes,
        },
        authRequired,
        emailEnv,
        passwordEnv,
        previewEnvIncludes,
        ...(typeof pagesPrefix === "string" ? { pagesPrefix } : {}),
        ...(Array.isArray(a.knownRoutes) ? { knownRoutes: a.knownRoutes } : {}),
        allowedMutationPatterns: allowed,
        ...(Array.isArray(a.productionMarkers) ? { productionMarkers: a.productionMarkers } : {}),
        ...(Array.isArray(a.destructiveControlPatterns)
            ? { destructiveControlPatterns: a.destructiveControlPatterns }
            : {}),
    },
};

process.stdout.write(`${JSON.stringify(normalized, null, 2)}\n`);
process.stderr.write(
    `build-config: OK — project id will be "${slug(repo)}"; credentials read from ${emailEnv} / ${passwordEnv}\n`,
);
