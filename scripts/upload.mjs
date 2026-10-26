#!/usr/bin/env node
// Guardhouse site upload client. Node 24+, ESM, zero dependencies.
// Protocol: docs/hosting.md in the main Guardhouse app (check -> PUT missing blobs -> finalize).
// API origins are hard-coded on purpose: the workflow chooses only `--env production|staging`, never a URL.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ORIGINS = Object.freeze({
  production: "https://useguardhouse.com",
  staging: "https://staging.useguardhouse.com",
});

const TEXT = "; charset=utf-8";
const TYPES = {
  html: "text/html" + TEXT,
  css: "text/css" + TEXT,
  js: "text/javascript" + TEXT,
  mjs: "text/javascript" + TEXT,
  json: "application/json" + TEXT,
  xml: "application/xml" + TEXT,
  txt: "text/plain" + TEXT,
  svg: "image/svg+xml" + TEXT,
  webmanifest: "application/manifest+json" + TEXT,
  map: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

export function contentType(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

/** Every file under dir (hidden ones included) as {path:"/a/b.html", file, size}. Rejects symlinks and non-regular files. */
export async function walk(dir) {
  const out = [];
  async function visit(abs, rel) {
    for (const name of await readdir(abs)) {
      const full = join(abs, name);
      const urlPath = `${rel}/${name}`;
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw new Error(`Refusing symlink in dist: ${urlPath}`);
      if (st.isDirectory()) await visit(full, urlPath);
      else if (st.isFile()) out.push({ path: urlPath, file: full, size: st.size });
      else throw new Error(`Refusing non-regular file in dist: ${urlPath}`);
    }
  }
  await visit(dir, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** Token provider backed by the Actions OIDC endpoint. Never logs the token. */
export function githubTokenProvider(env = process.env, fetchImpl = fetch) {
  return async (audience) => {
    const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
    const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    if (!url || !bearer) {
      throw new Error("OIDC token request is unavailable (the calling job needs `permissions: id-token: write`).");
    }
    const res = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`OIDC token request failed with HTTP ${res.status}`);
    const body = await res.json();
    if (!body?.value) throw new Error("OIDC token response had no value");
    return body.value;
  };
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload dir as one build.
 * api: { origin, getToken(audience) } (tests inject these; the CLI builds them from --env).
 * opts: { dir, commitSha, fetch, sleep, now, tokenMaxAgeMs, concurrency, retries, log }
 */
export async function upload(api, opts) {
  const {
    dir,
    commitSha,
    fetch: fetchImpl = fetch,
    sleep = sleepReal,
    now = Date.now,
    tokenMaxAgeMs = 4 * 60 * 1000,
    concurrency = 8,
    retries = 3,
    log = () => {},
  } = opts;
  const origin = api.origin.replace(/\/$/, "");

  let token = null;
  let tokenAt = 0;
  async function bearer() {
    if (!token || now() - tokenAt > tokenMaxAgeMs) {
      token = await api.getToken(origin);
      tokenAt = now();
    }
    return token;
  }

  async function request(method, path, { json, body, headers = {} } = {}) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const h = { ...headers, authorization: `Bearer ${await bearer()}` };
        if (json !== undefined) h["content-type"] = "application/json";
        res = await fetchImpl(origin + path, {
          method,
          headers: h,
          body: json !== undefined ? JSON.stringify(json) : body,
        });
      } catch (err) {
        if (err instanceof ApiError || attempt >= retries || /OIDC/.test(String(err?.message))) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await res.arrayBuffer().catch(() => {});
        await sleep(500 * 2 ** attempt);
        continue;
      }
      let code = `http_${res.status}`;
      let message = res.statusText || "request failed";
      try {
        const b = await res.json();
        if (b?.error?.code) code = String(b.error.code);
        if (b?.error?.message) message = String(b.error.message);
      } catch {}
      throw new ApiError(res.status, code, message);
    }
  }

  const found = await walk(dir);
  if (found.length === 0) throw new Error(`No files found in ${dir}`);
  const files = [];
  const byHash = new Map();
  for (const f of found) {
    const hash = await hashFile(f.file);
    files.push({ path: f.path, hash, size: f.size, contentType: contentType(f.path) });
    if (!byHash.has(hash)) byHash.set(hash, f.file);
  }
  log(`Manifest: ${files.length} files`);

  const check = await (await request("POST", "/api/sites/uploads/check", { json: { v: 1, commitSha, files } })).json();
  const missing = [...new Set(check.missing ?? [])];
  log(`Uploading ${missing.length} of ${byHash.size} unique blobs`);

  const queue = [...missing];
  async function worker() {
    for (let hash = queue.shift(); hash !== undefined; hash = queue.shift()) {
      const file = byHash.get(hash);
      if (!file) throw new Error(`Server asked for unknown hash ${hash}`);
      const bytes = await readFile(file);
      await request("PUT", `/api/sites/blobs/${hash}?session=${encodeURIComponent(check.sessionId)}`, {
        body: bytes,
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));

  const result = await (await request("POST", "/api/sites/builds", { json: { v: 1, sessionId: check.sessionId } })).json();
  return { ...result, files: files.length, uploaded: missing.length };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!["--env", "--dir", "--commit"].includes(k) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  if (!Object.hasOwn(ORIGINS, out.env ?? "")) throw new Error("--env must be production or staging");
  if (!out.dir) throw new Error("--dir is required");
  if (!/^[0-9a-f]{40}$/.test(out.commit ?? "")) throw new Error("--commit must be a 40-char lowercase sha");
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error("usage: upload.mjs --env production|staging --dir <dist> --commit <sha>");
    return 2;
  }
  const origin = ORIGINS[args.env];
  const summary = async (text) => {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n").catch(() => {});
  };
  try {
    const r = await upload(
      { origin, getToken: githubTokenProvider(env) },
      { dir: args.dir, commitSha: args.commit, log: (m) => console.log(m) },
    );
    console.log(`Build ${r.buildId} (${r.kind}) ${r.previewUrl ?? ""}`.trim());
    const lines = [`### Guardhouse upload (${args.env})`, `- Build: \`${r.buildId}\` (${r.kind})`, `- Files: ${r.files}, blobs uploaded: ${r.uploaded}`];
    if (r.previewUrl) lines.push(`- Preview: ${r.previewUrl}`);
    if (r.kind === "production") lines.push(r.promoted ? "- Went live." : "- Not live yet: waiting for Publish in admin.");
    await summary(lines.join("\n"));
    return 0;
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "client_error";
    console.error(`Upload failed: ${code}: ${err.message.replace(/^[a-z_0-9]+: /, "")}`);
    await summary(`### Guardhouse upload (${args.env}) failed\n\`${code}\``);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
