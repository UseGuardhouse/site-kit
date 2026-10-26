// Diff policy and lint for chat edits. Pure functions plus a filesystem walker; zero dependencies.
// The policy object mirrors `JobBundle.policy` from the Guardhouse API (sites.edit in the main app).
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Top-level names never compared (tooling state, not site content). */
export const IGNORED_TOP_LEVEL = Object.freeze([".git", ".site-kit", ".guardhouse", "node_modules", "dist", ".astro"]);

/** Path segments that are never editable, whatever editablePaths says (compared case-insensitively). */
const BLOCKED_SEGMENTS = new Set([".git", ".github", ".claude", ".site-kit", ".guardhouse", "node_modules"]);
/** File names that are never editable at any depth. */
const BLOCKED_BASENAMES = new Set(["claude.md", "claude.local.md", ".npmrc", ".mcp.json", ".gitattributes", ".gitmodules", ".gitignore"]);

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic"]);
const TEXT_EXT = new Set(["html", "htm", "astro", "md", "mdx", "svg", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "xml", "txt", "yml", "yaml", "webmanifest"]);

const MARKUP_EXT = new Set(["html", "htm", "astro", "svg", "md", "mdx"]);

const ext = (p) => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
};
export const isImage = (p) => IMAGE_EXT.has(ext(p));
export const isText = (p) => TEXT_EXT.has(ext(p));

/** Compile a glob (`**`, `*`, `?`) to an anchored RegExp over repo-relative, slash-separated paths. */
export function globToRegExp(glob, flags = "") {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, flags);
}

export function matchesAny(globs, path, flags = "") {
  return globs.some((g) => globToRegExp(g, flags).test(path));
}

/** Null when the path is a safe repo-relative path, else a reason. */
export function unsafePathReason(path) {
  if (typeof path !== "string" || path === "") return "empty path";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character in path";
  const segs = path.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "path traversal or empty segment";
  if (segs.some((s) => s !== s.trim() || /\.$/.test(s))) return "path segment with surrounding whitespace or trailing dot";
  return null;
}

/**
 * Walk dir and return Map<relPath, {kind:"file"|"symlink"|"other", size}>.
 * Directories are descended into; symlinked directories are reported as symlinks, never followed.
 */
export async function walkTree(dir) {
  const out = new Map();
  async function visit(abs, rel) {
    for (const name of await readdir(abs)) {
      if (rel === "" && IGNORED_TOP_LEVEL.includes(name)) continue;
      const full = join(abs, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = await lstat(full);
      if (st.isSymbolicLink()) out.set(relPath, { kind: "symlink", size: 0, full });
      else if (st.isDirectory()) await visit(full, relPath);
      else if (st.isFile()) out.set(relPath, { kind: "file", size: st.size, full });
      else out.set(relPath, { kind: "other", size: 0, full });
    }
  }
  await visit(dir, "");
  return out;
}

/**
 * Change set between two directory trees (base checkout and edited workspace).
 * extraSymlinks: paths known (from the edit job) to be symlinks in the edited workspace; they are reported as
 * "symlink" changes unless the base tree has a symlink at that path too.
 * Returns [{path, status:"added"|"modified"|"deleted"|"symlink"|"other", size, oldSize, full?, baseFull?}] sorted by path.
 */
export async function changeSet(baseDir, editedDir, { extraSymlinks = [] } = {}) {
  const base = await walkTree(baseDir);
  const edited = await walkTree(editedDir);
  const changes = [];
  for (const [path, e] of edited) {
    const b = base.get(path);
    if (e.kind !== "file") {
      if (b && b.kind === e.kind && e.kind === "symlink") continue;
      changes.push({ path, status: e.kind, size: 0, oldSize: b?.size ?? 0 });
      continue;
    }
    if (!b || b.kind !== "file") {
      changes.push({ path, status: "added", size: e.size, oldSize: 0, full: e.full });
      continue;
    }
    if (b.size !== e.size || !(await readFile(b.full)).equals(await readFile(e.full))) {
      changes.push({ path, status: "modified", size: e.size, oldSize: b.size, full: e.full, baseFull: b.full });
    }
  }
  for (const [path, b] of base) {
    if (!edited.has(path) && b.kind === "file" && !extraSymlinks.includes(path)) {
      changes.push({ path, status: "deleted", size: 0, oldSize: b.size, baseFull: b.full });
    }
  }
  for (const path of extraSymlinks) {
    const b = base.get(path);
    if (!(b && b.kind === "symlink") && !changes.some((c) => c.path === path)) changes.push({ path, status: "symlink", size: 0, oldSize: 0 });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Approximate bytes of changed lines between two texts (multiset line diff). */
export function diffBytes(oldText, newText) {
  const counts = new Map();
  for (const l of oldText.split("\n")) counts.set(l, (counts.get(l) ?? 0) + 1);
  let bytes = 0;
  for (const l of newText.split("\n")) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else bytes += Buffer.byteLength(l) + 1;
  }
  for (const [l, n] of counts) bytes += n * (Buffer.byteLength(l) + 1);
  return bytes;
}

/**
 * Check a change set against the policy. Returns null when fine, else {reason, detail}.
 * changes: from changeSet(); policy: JobBundle.policy. `patchBytes` may be passed in (computed from file contents).
 */
export function checkPolicy(changes, policy, { patchBytes = null } = {}) {
  if (changes.length === 0) return { reason: "no_changes", detail: "The edit changed no files." };
  for (const c of changes) {
    const bad = unsafePathReason(c.path);
    if (bad) return { reason: "path_not_allowed", detail: `${c.path}: ${bad}` };
    if (c.status === "symlink" || c.status === "other") return { reason: "path_not_allowed", detail: `${c.path}: symlinks and special files are not allowed` };
    const segs = c.path.toLowerCase().split("/");
    if (segs.some((s) => BLOCKED_SEGMENTS.has(s)) || BLOCKED_BASENAMES.has(segs[segs.length - 1])) {
      return { reason: "path_not_allowed", detail: `${c.path}: protected path` };
    }
    if (matchesAny(policy.blockedPaths, c.path, "i")) return { reason: "path_not_allowed", detail: `${c.path}: blocked path` };
    if (!matchesAny(policy.editablePaths, c.path)) return { reason: "path_not_allowed", detail: `${c.path}: outside the editable paths` };
  }
  if (changes.length > policy.maxChangedFiles) {
    return { reason: "too_many_files", detail: `${changes.length} files changed (limit ${policy.maxChangedFiles}).` };
  }
  for (const c of changes) {
    if ((c.status === "added" || c.status === "modified") && isImage(c.path) && c.size > policy.maxImageBytes) {
      return { reason: "image_too_large", detail: `${c.path} is ${c.size} bytes (limit ${policy.maxImageBytes}).` };
    }
  }
  const bytes =
    patchBytes ??
    changes.reduce((n, c) => (c.status === "added" || c.status === "modified") && !isImage(c.path) ? n + c.size : n, 0);
  if (bytes > policy.maxPatchBytes) return { reason: "patch_too_large", detail: `${bytes} bytes changed (limit ${policy.maxPatchBytes}).` };
  return null;
}

/** Patch bytes for a change set, reading file contents (images excluded; modified text files count changed lines only). */
export async function computePatchBytes(changes) {
  let total = 0;
  for (const c of changes) {
    if (c.status !== "added" && c.status !== "modified") continue;
    if (isImage(c.path)) continue;
    if (c.status === "modified" && isText(c.path)) {
      total += diffBytes((await readFile(c.baseFull)).toString("utf8"), (await readFile(c.full)).toString("utf8"));
    } else total += c.size;
  }
  return total;
}

const HOST_RES = [/https?:\/\/([a-z0-9][a-z0-9.-]*)/gi, /["'(=\s]\/\/([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)/gi];
/** Namespace identifiers, not network hosts. */
const NAMESPACE_HOSTS = new Set(["www.w3.org"]);

function hostsIn(text) {
  const set = new Set();
  for (const re of HOST_RES) for (const m of text.matchAll(re)) set.add(m[1].toLowerCase().replace(/\.$/, ""));
  return set;
}

function frontmatterRange(lines) {
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") return [1, i];
  return null;
}

/** src/forms/<id>.json: form definitions (the forms service validates them; this only surfaces the change for review). */
const FORM_DEF_RE = /^src\/forms\/(.+)\.json$/;
/** A hand-written form or form control outside src/guardhouse/ would bypass the forms service. */
const RAW_FORM_RE = /<(?:form|input|select|textarea)\b/i;

const IMPORT_RES = [/^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/, /^\s*import\s*['"]([^'"]+)['"]/, /\bimport\s*\(\s*['"]?([^'")]*)/];

/**
 * Lint added/modified text files. Only lines (and hosts) newly introduced by the change are reported.
 * files: [{path, oldText, newText}] (oldText "" for added files). Returns [{rule, file, line, detail}].
 */
export function lint(files, policy) {
  const allowedHosts = new Set((policy.allowedExternalHosts ?? []).map((h) => h.toLowerCase()));
  const findings = [];
  const add = (rule, file, line, detail) => findings.push({ rule, file: file.slice(0, 512), line, detail: detail.slice(0, 300) });
  for (const f of files) {
    const formDef = FORM_DEF_RE.exec(f.path);
    if (formDef) {
      const status = f.status ?? (f.oldText === "" ? "added" : f.newText === "" ? "deleted" : "modified");
      add("form_definition", f.path, 1, `Form "${formDef[1]}" definition ${status}.`);
    }
    if (!isText(f.path)) continue;
    // Deleted files have nothing new to lint.
    if (f.status === "deleted") continue;
    const oldLines = f.oldText.split("\n");
    const newLines = f.newText.split("\n");
    const remaining = new Map();
    for (const l of oldLines) remaining.set(l, (remaining.get(l) ?? 0) + 1);
    const isNew = newLines.map((l) => {
      const n = remaining.get(l) ?? 0;
      if (n > 0) {
        remaining.set(l, n - 1);
        return false;
      }
      return true;
    });
    const oldHosts = hostsIn(f.oldText);
    const fm = ext(f.path) === "astro" ? frontmatterRange(newLines) : null;
    const oldImports = new Set();
    if (fm) {
      for (const l of oldLines) for (const re of IMPORT_RES) { const m = re.exec(l); if (m) oldImports.add(m[1]); }
    }
    const reportedHosts = new Set();
    newLines.forEach((line, idx) => {
      if (!isNew[idx]) return;
      const n = idx + 1;
      const snippet = line.trim().slice(0, 120);
      if (/<script\b/i.test(line)) add("script_tag", f.path, n, `New <script> tag: ${snippet}`);
      if (MARKUP_EXT.has(ext(f.path)) && /(^|[\s"'`<>/])on[a-z]{3,}\s*=/i.test(line)) add("event_handler", f.path, n, `New inline event handler: ${snippet}`);
      if (/javascript\s*:/i.test(line)) add("javascript_url", f.path, n, `New javascript: URL: ${snippet}`);
      if (/set:html/.test(line)) add("set_html", f.path, n, `New set:html: ${snippet}`);
      if (RAW_FORM_RE.test(line) && MARKUP_EXT.has(ext(f.path)) && !f.path.startsWith("src/guardhouse/")) add("raw_form", f.path, n, `New raw form markup (use GuardhouseForm): ${snippet}`);
      if (/<iframe\b/i.test(line)) add("iframe", f.path, n, `New <iframe>: ${snippet}`);
      for (const host of hostsIn(line)) {
        if (allowedHosts.has(host) || oldHosts.has(host) || NAMESPACE_HOSTS.has(host) || reportedHosts.has(host)) continue;
        reportedHosts.add(host);
        add("external_host", f.path, n, `New external host: ${host}`);
      }
      if (fm && idx >= fm[0] && idx < fm[1]) {
        if (/\bfetch\s*\(/.test(line)) add("frontmatter_code", f.path, n, `fetch() in frontmatter: ${snippet}`);
        if (/\bprocess\./.test(line)) add("frontmatter_code", f.path, n, `process access in frontmatter: ${snippet}`);
        if (/import\.meta\.env/.test(line)) add("frontmatter_code", f.path, n, `import.meta.env in frontmatter: ${snippet}`);
        for (const re of IMPORT_RES) {
          const m = re.exec(line);
          if (!m) continue;
          const spec = m[1];
          if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("astro:") || oldImports.has(spec)) break;
          add("frontmatter_code", f.path, n, `Import of non-local module: ${spec || snippet}`);
          break;
        }
      }
    });
  }
  return findings;
}
