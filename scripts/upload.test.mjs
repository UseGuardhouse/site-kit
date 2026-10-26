import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ApiError, ORIGINS, contentType, main, upload, walk } from "./upload.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const COMMIT = "a".repeat(40);

async function makeDist() {
  const dir = await mkdtemp(join(tmpdir(), "dist-"));
  await mkdir(join(dir, "about"));
  await writeFile(join(dir, "index.html"), "<h1>home</h1>");
  await writeFile(join(dir, "about", "index.html"), "<h1>about</h1>");
  await writeFile(join(dir, "_redirects"), "/old /new 301\n");
  await writeFile(join(dir, "dupe.txt"), "<h1>home</h1>");
  return dir;
}

let server, origin, state;
function reset(over = {}) {
  state = { checks: [], puts: [], finals: [], tokens: 0, missing: null, putFailures: [], putStatus: null, checkStatus: null, ...over };
}
before(async () => {
  reset();
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    if (!req.headers.authorization?.startsWith("Bearer tok")) return send(401, { error: { code: "unauthorized", message: "no" } });
    state.lastAuth = req.headers.authorization;
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/api/sites/uploads/check") {
      if (state.checkStatus) return send(state.checkStatus, { error: { code: "bad_manifest", message: "nope" } });
      const j = JSON.parse(body); state.checks.push(j);
      const hashes = [...new Set(j.files.map((f) => f.hash))];
      return send(200, { sessionId: "sess-1234567890abcdef", missing: state.missing ?? hashes });
    }
    if (req.method === "PUT" && url.pathname.startsWith("/api/sites/blobs/")) {
      const hash = url.pathname.split("/").pop();
      state.puts.push({ hash, session: url.searchParams.get("session"), ct: req.headers["content-type"], len: req.headers["content-length"], ok: sha(body) === hash });
      if (state.putFailures.length) return send(state.putFailures.shift(), { error: { code: "boom", message: "x" } });
      return send(204);
    }
    if (req.method === "POST" && url.pathname === "/api/sites/builds") {
      state.finals.push(JSON.parse(body));
      return send(200, { buildId: "b1", kind: "production", promoted: true });
    }
    send(404, { error: { code: "not_found", message: "x" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = () => ({ origin, getToken: async () => `tok${++state.tokens}` });
const fast = { sleep: async () => {}, commitSha: COMMIT };

describe("upload", () => {
  test("manifest has paths, hashes, sizes, types, hidden files", async () => {
    reset();
    const dir = await makeDist();
    const r = await upload(api(), { ...fast, dir });
    assert.equal(r.buildId, "b1");
    const m = state.checks[0];
    assert.equal(m.v, 1);
    assert.equal(m.commitSha, COMMIT);
    assert.deepEqual(m.files.map((f) => f.path), ["/_redirects", "/about/index.html", "/dupe.txt", "/index.html"]);
    const home = m.files.find((f) => f.path === "/index.html");
    assert.deepEqual(home, { path: "/index.html", hash: sha("<h1>home</h1>"), size: 13, contentType: "text/html; charset=utf-8" });
    assert.equal(m.files.find((f) => f.path === "/_redirects").contentType, "application/octet-stream");
    assert.equal(m.files.find((f) => f.path === "/dupe.txt").contentType, "text/plain; charset=utf-8");
    assert.deepEqual(state.finals, [{ v: 1, sessionId: "sess-1234567890abcdef" }]);
  });

  test("PUTs only missing blobs, once per unique hash", async () => {
    reset();
    const dir = await makeDist();
    state.missing = [sha("<h1>home</h1>")];
    const r = await upload(api(), { ...fast, dir });
    assert.equal(state.puts.length, 1);
    assert.equal(state.puts[0].hash, sha("<h1>home</h1>"));
    assert.equal(state.puts[0].session, "sess-1234567890abcdef");
    assert.equal(state.puts[0].ct, "application/octet-stream");
    assert.equal(state.puts[0].len, "13");
    assert.ok(state.puts[0].ok);
    assert.equal(r.uploaded, 1);
  });

  test("uploads every unique blob when all are missing", async () => {
    reset();
    await upload(api(), { ...fast, dir: await makeDist() });
    assert.equal(state.puts.length, 3);
    assert.ok(state.puts.every((p) => p.ok));
  });

  test("retries 503 then succeeds", async () => {
    reset({ putFailures: [503, 429] });
    state.missing = [sha("<h1>about</h1>")];
    await upload(api(), { ...fast, dir: await makeDist() });
    assert.equal(state.puts.length, 3);
  });

  test("gives up after 3 retries on persistent 5xx", async () => {
    reset({ putFailures: [500, 500, 500, 500, 500] });
    state.missing = [sha("<h1>about</h1>")];
    await assert.rejects(upload(api(), { ...fast, dir: await makeDist() }), (e) => e instanceof ApiError && e.status === 500);
    assert.equal(state.puts.length, 4);
  });

  test("does not retry on 400", async () => {
    reset({ putFailures: [400] });
    state.missing = [sha("<h1>about</h1>")];
    await assert.rejects(upload(api(), { ...fast, dir: await makeDist() }), (e) => e.code === "boom" && e.status === 400);
    assert.equal(state.puts.length, 1);
  });

  test("API error carries code and message", async () => {
    reset({ checkStatus: 400 });
    await assert.rejects(upload(api(), { ...fast, dir: await makeDist() }), (e) => e.code === "bad_manifest" && /nope/.test(e.message));
  });

  test("refreshes the token when older than the max age", async () => {
    reset();
    let t = 0;
    state.missing = [sha("<h1>home</h1>")];
    const fetchSlow = async (...a) => { t += 5 * 60 * 1000; return fetch(...a); };
    await upload(api(), { ...fast, dir: await makeDist(), now: () => t, fetch: fetchSlow });
    assert.ok(state.tokens >= 3, `tokens requested: ${state.tokens}`);
    assert.equal(state.lastAuth, `Bearer tok${state.tokens}`);
  });

  test("reuses a fresh token", async () => {
    reset();
    await upload(api(), { ...fast, dir: await makeDist(), now: () => 0 });
    assert.equal(state.tokens, 1);
  });

  test("rejects symlinks", async () => {
    reset();
    const dir = await makeDist();
    await symlink("/etc/hosts", join(dir, "evil.txt"));
    await assert.rejects(walk(dir), /symlink/);
    await assert.rejects(upload(api(), { ...fast, dir }), /symlink/);
    assert.equal(state.checks.length, 0);
  });
});

describe("helpers and CLI", () => {
  test("contentType map", () => {
    assert.equal(contentType("/a.CSS"), "text/css; charset=utf-8");
    assert.equal(contentType("/a.woff2"), "font/woff2");
    assert.equal(contentType("/a.webmanifest"), "application/manifest+json; charset=utf-8");
    assert.equal(contentType("/a.map"), "application/json");
    assert.equal(contentType("/noext"), "application/octet-stream");
  });

  test("origins are fixed", () => {
    assert.deepEqual({ ...ORIGINS }, { production: "https://useguardhouse.com", staging: "https://staging.useguardhouse.com" });
  });

  test("CLI rejects URLs and unknown envs, exits non-zero", async () => {
    const quiet = console.error; console.error = () => {};
    try {
      assert.equal(await main(["--env", "https://evil.example", "--dir", "x", "--commit", COMMIT], {}), 2);
      assert.equal(await main(["--env", "production", "--origin", "http://x", "--dir", "x", "--commit", COMMIT], {}), 2);
      assert.equal(await main(["--env", "staging", "--dir", "x", "--commit", "abc"], {}), 2);
    } finally { console.error = quiet; }
  });

  test("CLI exits 1 without an OIDC environment and prints no token", async () => {
    const dir = await makeDist();
    const lines = []; const quiet = console.error; console.error = (m) => lines.push(m);
    try {
      assert.equal(await main(["--env", "production", "--dir", dir, "--commit", COMMIT], {}), 1);
    } finally { console.error = quiet; }
    assert.match(lines.join("\n"), /id-token: write/);
  });
});
