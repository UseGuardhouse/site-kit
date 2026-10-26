#!/usr/bin/env node
// Guardhouse chat-edit job client. Node 24+, ESM, zero dependencies.
// Subcommands (run by .github/workflows/edit.yml):
//   prepare  --job ID --repository OWNER/NAME --out DIR      fetch the job bundle + media, report `started`
//   place    --bundle DIR --dest DIR                         write .guardhouse/request.json and media into a checkout
//   push     --job ID --repository OWNER/NAME --bundle DIR --workspace DIR --result DIR [--checkout DIR]
//                                                            policy + lint + commit + push the edited workspace
//   fail     --job ID --repository OWNER/NAME --stage S --message M
// Protocol: docs/hosting.md ("Edit-job endpoints") in the main Guardhouse app. API origins are hard-coded in lib.mjs.
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError, ORIGINS, createClient, envForRepository, githubTokenProvider } from "./lib.mjs";
import { changeSet, checkPolicy, computePatchBytes, isText, lint, unsafePathReason } from "./policy.mjs";

const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOT_NAME = "Guardhouse";
const BOT_EMAIL = "guardhouse-bot@users.noreply.github.com";
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const STAGES = ["prepare", "edit", "push", "build", "upload"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isStrArr = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Validate and normalise a JobBundle. Throws on anything unexpected (the bundle feeds claude_args and file paths). */
export function validateBundle(b, jobId) {
  const fail = (m) => {
    throw new Error(`Invalid job bundle: ${m}`);
  };
  if (!isObj(b) || b.v !== 1) fail("unsupported version");
  if (b.jobId !== jobId) fail("jobId mismatch");
  if (typeof b.changeRequestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.changeRequestId)) fail("changeRequestId");
  if (typeof b.branch !== "string" || !/^change\/[A-Za-z0-9_-]{1,64}$/.test(b.branch)) fail("branch");
  if (b.baseRef !== "main" && b.baseRef !== b.branch) fail("baseRef must be main or the change branch");
  if (typeof b.model !== "string" || !/^[A-Za-z0-9._-]{1,100}$/.test(b.model)) fail("model");
  if (!isInt(b.maxTurns, 1, 200)) fail("maxTurns");
  if (typeof b.prompt !== "string" || b.prompt.length === 0 || b.prompt.length > 200_000) fail("prompt");
  if (!isObj(b.request)) fail("request");
  if (!Array.isArray(b.media) || b.media.length > 100) fail("media");
  for (const m of b.media) {
    if (!isObj(m) || !isInt(m.n, 0, 1_000_000) || !isInt(m.size, 0, MAX_MEDIA_BYTES)) fail("media entry");
    if (typeof m.path !== "string" || !/^public\/uploads\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(m.path) || unsafePathReason(m.path)) {
      fail(`media path ${JSON.stringify(String(m.path).slice(0, 80))} is not under public/uploads/`);
    }
  }
  const p = b.policy;
  if (!isObj(p) || !isStrArr(p.editablePaths) || !isStrArr(p.blockedPaths) || !isStrArr(p.allowedExternalHosts)) fail("policy");
  if (![p.maxChangedFiles, p.maxPatchBytes, p.maxImageBytes].every((n) => isInt(n, 0, Number.MAX_SAFE_INTEGER))) fail("policy limits");
  return b;
}

/** Validate Claude's structured result (EditResult). Returns the normalised object or throws. */
export function validateEditResult(r) {
  if (!isObj(r)) throw new Error("result is not an object");
  const { summary, changed, needs_human, question } = r;
  if (typeof summary !== "string" || summary.length > 2000) throw new Error("result.summary invalid");
  if (typeof changed !== "boolean") throw new Error("result.changed invalid");
  if (typeof needs_human !== "boolean") throw new Error("result.needs_human invalid");
  if (!(question === null || (typeof question === "string" && question.length <= 2000))) throw new Error("result.question invalid");
  return { summary, changed, needs_human, question };
}

/** costUsd / usage from the Claude Code execution file (array of turns ending in a `result` entry, or a single object). */
export function readExecution(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { costUsd: null, usage: null };
  }
  const entry = Array.isArray(data) ? [...data].reverse().find((e) => isObj(e) && e.type === "result") : data;
  if (!isObj(entry)) return { costUsd: null, usage: null };
  const costUsd = typeof entry.total_cost_usd === "number" && entry.total_cost_usd >= 0 ? entry.total_cost_usd : null;
  let usage = null;
  if (isObj(entry.usage)) {
    usage = {};
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      if (isInt(entry.usage[k], 0, Number.MAX_SAFE_INTEGER)) usage[k] = entry.usage[k];
    }
  }
  return { costUsd, usage };
}

async function setOutputs(file, outputs) {
  if (!file) return;
  let text = "";
  for (const [k, v] of Object.entries(outputs)) {
    const s = String(v);
    if (/[\r\n]/.test(s)) throw new Error(`Refusing multi-line output ${k}`);
    text += `${k}=${s}\n`;
  }
  await appendFile(file, text);
}

const oneLine = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function postStatus(client, jobId, body) {
  return client.request("POST", `/api/sites/jobs/${jobId}/status`, { json: { v: 1, ...body } });
}

/** Refuse to write through symlinks: every existing component of root/rel must be a real directory (or the file itself a non-symlink). */
async function assertNoSymlinkPath(root, rel) {
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    let st;
    try {
      st = await lstat(cur);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${rel}`);
  }
}

// ---------------------------------------------------------------- prepare

export async function prepare({ client, jobId, outDir, outputFile, log = () => {} }) {
  const res = await client.request("GET", `/api/sites/jobs/${jobId}/bundle`);
  const bundle = validateBundle(await res.json(), jobId);
  await mkdir(join(outDir, "media"), { recursive: true });
  await writeFile(join(outDir, "bundle.json"), JSON.stringify(bundle));
  await writeFile(join(outDir, "request.json"), JSON.stringify(bundle.request, null, 2));
  await writeFile(join(outDir, "prompt.txt"), bundle.prompt);
  for (const m of bundle.media) {
    const r = await client.request("GET", `/api/sites/jobs/${jobId}/media/${m.n}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length !== m.size) throw new Error(`Media ${m.n} size mismatch (expected ${m.size}, got ${bytes.length})`);
    await writeFile(join(outDir, "media", String(m.n)), bytes);
  }
  log(`Bundle ${bundle.changeRequestId}: ${bundle.media.length} media file(s), base ${bundle.baseRef}`);
  await postStatus(client, jobId, { phase: "started" });
  await setOutputs(outputFile, {
    base_ref: bundle.baseRef,
    branch: bundle.branch,
    model: bundle.model,
    max_turns: bundle.maxTurns,
    prepared: "true",
  });
  return bundle;
}

// ---------------------------------------------------------------- place

export async function place({ bundleDir, destDir, jobId }) {
  const raw = JSON.parse(await readFile(join(bundleDir, "bundle.json"), "utf8"));
  const bundle = validateBundle(raw, jobId ?? raw.jobId);
  await assertNoSymlinkPath(destDir, ".guardhouse");
  await mkdir(join(destDir, ".guardhouse"), { recursive: true });
  await writeFile(join(destDir, ".guardhouse", "request.json"), JSON.stringify(bundle.request, null, 2));
  for (const m of bundle.media) {
    await assertNoSymlinkPath(destDir, m.path);
    const target = join(destDir, m.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(bundleDir, "media", String(m.n)), target);
  }
  return bundle.media.map((m) => m.path);
}

// ---------------------------------------------------------------- push

function git(cwd, args, { env = {}, input } = {}) {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0", ...env },
  }).trim();
}

export async function push({ client, jobId, bundleDir, workspaceDir, resultDir, checkoutDir = ".", outputFile, log = () => {} }) {
  const bundle = validateBundle(JSON.parse(await readFile(join(bundleDir, "bundle.json"), "utf8")), jobId);

  // 1. Claude's result -> `edited`.
  let result;
  try {
    result = validateEditResult(JSON.parse(await readFile(join(resultDir, "result.json"), "utf8")));
  } catch (err) {
    throw new Error(`Claude produced no valid structured result (${err.message})`);
  }
  let exec = { costUsd: null, usage: null };
  try {
    exec = readExecution(await readFile(join(resultDir, "execution.json"), "utf8"));
  } catch {}
  await postStatus(client, jobId, { phase: "edited", result, costUsd: exec.costUsd, model: bundle.model, usage: exec.usage });

  const reject = async (reason, detail) => {
    log(`Rejected: ${reason}: ${detail}`);
    await postStatus(client, jobId, { phase: "rejected", reason, detail: oneLine(detail, 1000) });
    return { pushed: false, reason };
  };

  if (result.needs_human) return reject("needs_human", result.question || result.summary || "Claude asked for a human.");

  // 2. Change set + policy.
  let extraSymlinks = [];
  try {
    extraSymlinks = (await readFile(join(resultDir, "symlinks.bin"), "utf8")).split("\0").filter(Boolean).map((p) => p.replace(/^\.\//, ""));
  } catch {}
  const changes = await changeSet(checkoutDir, workspaceDir, { extraSymlinks });
  const violation = checkPolicy(changes, bundle.policy, { patchBytes: await computePatchBytes(changes) });
  if (violation) return reject(violation.reason, violation.detail);

  // 3. Lint (findings, not failures).
  const lintFiles = [];
  for (const c of changes) {
    if ((c.status !== "added" && c.status !== "modified") || !isText(c.path)) continue;
    lintFiles.push({
      path: c.path,
      oldText: c.baseFull ? await readFile(c.baseFull, "utf8") : "",
      newText: await readFile(c.full, "utf8"),
    });
  }
  const findings = lint(lintFiles, bundle.policy).slice(0, 200);

  // 4. Apply onto the checkout, commit, push.
  for (const c of changes) {
    await assertNoSymlinkPath(checkoutDir, c.path);
    const target = join(checkoutDir, c.path);
    if (c.status === "deleted") await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(c.full, target);
    }
  }
  const baseSha = git(checkoutDir, ["rev-parse", "HEAD"]);
  const remoteHeads = git(checkoutDir, ["ls-remote", "--heads", "origin", `refs/heads/${bundle.branch}`]);
  const existedRemotely = remoteHeads.length > 0;
  git(checkoutDir, ["switch", "-C", bundle.branch]);
  const paths = changes.map((c) => c.path);
  git(checkoutDir, ["add", "-A", "--", ...paths]);
  const firstLine = oneLine(result.summary.split("\n")[0], 100) || "chat edit";
  git(checkoutDir, [
    "-c", `user.name=${BOT_NAME}`,
    "-c", `user.email=${BOT_EMAIL}`,
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--no-verify", "-m", `Change request ${bundle.changeRequestId}: ${firstLine}`,
  ]);
  const headSha = git(checkoutDir, ["rev-parse", "HEAD"]);
  const pushArgs = ["push", "origin", `HEAD:refs/heads/${bundle.branch}`];
  if (existedRemotely && bundle.baseRef === bundle.branch) pushArgs.splice(1, 0, `--force-with-lease=refs/heads/${bundle.branch}:${baseSha}`);
  git(checkoutDir, pushArgs);
  log(`Pushed ${bundle.branch} at ${headSha} (${paths.length} file(s), ${findings.length} lint finding(s))`);

  await postStatus(client, jobId, { phase: "pushed", branch: bundle.branch, headSha, changedFiles: paths.slice(0, 500), lint: findings });
  await setOutputs(outputFile, { head_sha: headSha, pushed: "true" });
  return { pushed: true, headSha, changedFiles: paths, lint: findings };
}

// ---------------------------------------------------------------- fail

export async function fail({ client, jobId, stage, message }) {
  if (!STAGES.includes(stage)) throw new Error(`stage must be one of ${STAGES.join(", ")}`);
  await postStatus(client, jobId, { phase: "failed", stage, message: oneLine(message || "The job failed.", 1000) });
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!allowed.includes(k) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument: ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

const COMMANDS = {
  prepare: { args: ["--job", "--repository", "--out"], required: ["job", "repository", "out"] },
  place: { args: ["--bundle", "--dest"], required: ["bundle", "dest"] },
  push: { args: ["--job", "--repository", "--bundle", "--workspace", "--result", "--checkout"], required: ["job", "repository", "bundle", "workspace", "result"] },
  fail: { args: ["--job", "--repository", "--stage", "--message"], required: ["job", "repository", "stage", "message"] },
};

/** deps (tests only): { origin, getToken, fetch, sleep }. The CLI derives the origin from --repository and never from env/argv. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const [cmd, ...rest] = argv;
  let args;
  try {
    const spec = COMMANDS[cmd];
    if (!spec) throw new Error(`Unknown command: ${cmd}`);
    args = parseArgs(rest, spec.args);
    for (const k of spec.required) if (args[k] === undefined) throw new Error(`--${k} is required`);
    if (args.job !== undefined && !JOB_ID.test(args.job)) throw new Error("--job is not a valid job id");
  } catch (err) {
    console.error(err.message);
    console.error(`usage: job.mjs prepare|place|push|fail ... (see header of scripts/job.mjs)`);
    return 2;
  }
  const log = (m) => console.log(m);
  const summary = async (text) => {
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, text + "\n").catch(() => {});
  };
  try {
    if (cmd === "place") {
      const paths = await place({ bundleDir: args.bundle, destDir: args.dest });
      log(`Placed request and ${paths.length} media file(s)`);
      return 0;
    }
    const target = envForRepository(args.repository);
    log(`Environment: ${target}`);
    const api = { origin: deps.origin ?? ORIGINS[target], getToken: deps.getToken ?? githubTokenProvider(env) };
    const client = createClient(api, { fetch: deps.fetch, sleep: deps.sleep });
    if (cmd === "prepare") {
      await prepare({ client, jobId: args.job, outDir: args.out, outputFile: env.GITHUB_OUTPUT, log });
    } else if (cmd === "push") {
      const r = await push({
        client, jobId: args.job, bundleDir: args.bundle, workspaceDir: args.workspace, resultDir: args.result,
        checkoutDir: args.checkout ?? ".", outputFile: env.GITHUB_OUTPUT, log,
      });
      await summary(r.pushed ? `### Guardhouse edit pushed\n- Commit: \`${r.headSha}\`\n- Files: ${r.changedFiles.length}\n- Lint findings: ${r.lint.length}` : `### Guardhouse edit not pushed\n- Reason: \`${r.reason}\``);
    } else {
      await fail({ client, jobId: args.job, stage: args.stage, message: args.message });
    }
    return 0;
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "client_error";
    console.error(`${cmd} failed: ${code}: ${String(err.message).replace(/^[a-z_0-9]+: /, "").slice(0, 500)}`);
    await summary(`### Guardhouse ${cmd} failed\n\`${code}\``);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
