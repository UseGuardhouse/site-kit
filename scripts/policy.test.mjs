import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { changeSet, checkPolicy, computePatchBytes, diffBytes, globToRegExp, lint, matchesAny } from "./policy.mjs";

const policy = {
  editablePaths: ["src/content/**", "src/pages/**", "src/components/**", "src/styles/**", "src/assets/**", "public/**"],
  blockedPaths: ["public/_headers", "public/_redirects"],
  allowedExternalHosts: ["www.google.com", "maps.google.com", "www.youtube-nocookie.com", "player.vimeo.com"],
  maxChangedFiles: 40,
  maxPatchBytes: 2 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
};
const ch = (path, status = "modified", size = 10) => ({ path, status, size, oldSize: 5 });

describe("globs", () => {
  test("** and * semantics", () => {
    assert.ok(globToRegExp("src/pages/**").test("src/pages/a/b/c.astro"));
    assert.ok(globToRegExp("src/pages/**").test("src/pages/index.astro"));
    assert.ok(!globToRegExp("src/pages/**").test("src/pagesX/index.astro"));
    assert.ok(globToRegExp("src/*.astro").test("src/a.astro"));
    assert.ok(!globToRegExp("src/*.astro").test("src/a/b.astro"));
    assert.ok(globToRegExp("**/x.md").test("x.md"));
    assert.ok(globToRegExp("**/x.md").test("a/b/x.md"));
    assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("aXb"));
    assert.ok(matchesAny(["public/_headers"], "public/_HEADERS", "i"));
  });
});

describe("checkPolicy", () => {
  const allowed = [
    "src/content/pages/about.md",
    "src/pages/index.astro",
    "src/components/Hero.astro",
    "src/styles/global.css",
    "src/assets/logo.png",
    "public/uploads/photo.jpg",
    "public/robots.txt",
  ];
  for (const p of allowed) test(`allows ${p}`, () => assert.equal(checkPolicy([ch(p)], policy), null));

  const blocked = [
    ".github/workflows/x.yml",
    "CLAUDE.md",
    ".claude/settings.json",
    ".npmrc",
    "package.json",
    "package-lock.json",
    "public/_headers",
    "public/_redirects",
    "public/_HEADERS",
    "astro.config.mjs",
    "src/pages/../../package.json",
    "../outside.txt",
    "/etc/passwd",
    "src\\pages\\x.astro",
    "src/pages//x.astro",
    "src/pages/./x.astro",
    "src/pages/.git/config",
    "public/.github/x.yml",
    "src/content/CLAUDE.md",
    "src/components/node_modules/x.js",
    "public/ok.txt\u0000.png",
  ];
  for (const p of blocked) {
    test(`rejects ${JSON.stringify(p)}`, () => {
      const r = checkPolicy([ch(p)], policy);
      assert.equal(r?.reason, "path_not_allowed", JSON.stringify(r));
    });
  }

  test("deleting a blocked path is rejected, deleting an editable one is allowed", () => {
    assert.equal(checkPolicy([ch("package.json", "deleted", 0)], policy)?.reason, "path_not_allowed");
    assert.equal(checkPolicy([ch("src/content/old.md", "deleted", 0)], policy), null);
  });
  test("symlinks and special files", () => {
    assert.equal(checkPolicy([ch("src/pages/link", "symlink", 0)], policy)?.reason, "path_not_allowed");
    assert.equal(checkPolicy([ch("src/pages/fifo", "other", 0)], policy)?.reason, "path_not_allowed");
  });
  test("no changes", () => assert.equal(checkPolicy([], policy)?.reason, "no_changes"));
  test("41 files is too many, 40 is fine", () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ch(`src/content/p${i}.md`, "added", 100));
    assert.equal(checkPolicy(many(41), policy)?.reason, "too_many_files");
    assert.equal(checkPolicy(many(40), policy), null);
  });
  test("6 MB image is too large; 5 MB is fine and does not count toward the patch limit", () => {
    assert.equal(checkPolicy([ch("public/uploads/big.jpg", "added", 6 * 1024 * 1024)], policy)?.reason, "image_too_large");
    assert.equal(checkPolicy([ch("public/uploads/a.jpg", "added", 5 * 1024 * 1024), ch("public/uploads/b.png", "added", 5 * 1024 * 1024), ch("public/uploads/c.png", "added", 5 * 1024 * 1024)], policy), null);
  });
  test("patch too large (non-image bytes)", () => {
    assert.equal(checkPolicy([ch("public/video.mp4", "added", 3 * 1024 * 1024)], policy)?.reason, "patch_too_large");
    assert.equal(checkPolicy([ch("src/content/a.md")], policy, { patchBytes: policy.maxPatchBytes + 1 })?.reason, "patch_too_large");
  });
  test("path violations win over count violations", () => {
    const many = Array.from({ length: 50 }, (_, i) => ch(`src/content/p${i}.md`));
    many.push(ch(".github/workflows/x.yml"));
    assert.equal(checkPolicy(many, policy)?.reason, "path_not_allowed");
  });
});

describe("diffBytes", () => {
  test("counts only changed lines", () => {
    assert.equal(diffBytes("a\nb\nc", "a\nb\nc"), 0);
    assert.equal(diffBytes("a\nb\nc", "a\nB\nc"), 2 + 2);
  });
});

describe("lint", () => {
  const f = (path, newText, oldText = "") => ({ path, newText, oldText });
  const rules = (files) => lint(files, policy).map((x) => x.rule);

  test("script tag with external src flags script_tag and the host", () => {
    const out = lint([f("src/pages/a.astro", '<h1>x</h1>\n<script src="https://evil.example/x.js"></script>')], policy);
    assert.deepEqual(out.map((x) => x.rule).sort(), ["external_host", "script_tag"]);
    assert.equal(out.find((x) => x.rule === "script_tag").line, 2);
    assert.equal(out.find((x) => x.rule === "script_tag").file, "src/pages/a.astro");
  });
  test("inline handlers", () => {
    assert.deepEqual(rules([f("src/pages/a.html", '<img src="a.png" onerror="alert(1)">')]), ["event_handler"]);
    assert.deepEqual(rules([f("src/pages/a.html", '<button\n  onclick = "x()">')]), ["event_handler"]);
    assert.deepEqual(rules([f("src/pages/a.html", '<meta content="x">')]), []);
  });
  test("javascript: URLs, set:html, iframe", () => {
    assert.deepEqual(rules([f("src/pages/a.html", '<a href="javascript:alert(1)">x</a>')]), ["javascript_url"]);
    assert.deepEqual(rules([f("src/pages/a.astro", "<div set:html={body} />")]), ["set_html"]);
    assert.deepEqual(rules([f("src/pages/a.html", '<iframe src="/local"></iframe>')]), ["iframe"]);
  });
  test("external hosts: allowed host quiet, new host flagged, existing host quiet", () => {
    assert.deepEqual(rules([f("src/pages/a.html", '<a href="https://www.google.com/maps">m</a>')]), []);
    const out = lint([f("src/pages/a.html", '<a href="https://shop.example.com/buy">b</a>')], policy);
    assert.deepEqual(out.map((x) => x.rule), ["external_host"]);
    assert.match(out[0].detail, /shop\.example\.com/);
    const old = '<a href="https://shop.example.com/buy">b</a>';
    assert.deepEqual(rules([f("src/pages/a.html", old + "\n<p>new</p>", old)]), []);
    assert.deepEqual(rules([f("src/pages/a.html", '<img src="//cdn.evil.example/x.png">')]), ["external_host"]);
    assert.deepEqual(rules([f("src/assets/a.svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')]), []);
  });
  test("only newly added lines are linted", () => {
    const old = '<script src="/a.js"></script>\n<p>old</p>';
    assert.deepEqual(rules([f("src/pages/a.html", old.replace("old", "new"), old)]), []);
    assert.deepEqual(rules([f("src/pages/a.html", old + '\n<script>1</script>', old)]), ["script_tag"]);
  });
  test(".astro frontmatter code", () => {
    const fm = (body) => f("src/pages/a.astro", `---\n${body}\n---\n<p>hi</p>`);
    assert.deepEqual(rules([fm("const r = await fetch('/api');")]), ["frontmatter_code"]);
    assert.deepEqual(rules([fm("const k = import.meta.env.SECRET;")]), ["frontmatter_code"]);
    assert.deepEqual(rules([fm("const k = process.env.X;")]), ["frontmatter_code"]);
    assert.deepEqual(rules([fm("import x from 'left-pad';")]), ["frontmatter_code"]);
    assert.deepEqual(rules([fm("import Layout from '../layouts/Layout.astro';")]), []);
    assert.deepEqual(rules([fm("import { getCollection } from 'astro:content';")]), []);
    // fetch( in the template body is not frontmatter
    assert.deepEqual(rules([f("src/pages/a.astro", "---\n---\n<p>fetch(x)</p>")]), []);
    // an import that already existed is not flagged
    const old = "---\nimport x from 'left-pad';\n---\n<p/>";
    assert.deepEqual(rules([f("src/pages/a.astro", old.replace("<p/>", "<p>1</p>") + "\n", old)]), []);
  });
  test("form_definition: added, modified and deleted files under src/forms/", () => {
    const out = lint(
      [
        f("src/forms/contact.json", "{}"),
        f("src/forms/quote-request.json", '{"a":2}', '{"a":1}'),
        { path: "src/forms/old.json", oldText: "", newText: "", status: "deleted" },
        f("src/content/forms/x.json", "{}"),
        f("src/forms/readme.txt", "x"),
      ],
      policy,
    ).filter((x) => x.rule === "form_definition");
    assert.deepEqual(out.map((x) => x.file), ["src/forms/contact.json", "src/forms/quote-request.json", "src/forms/old.json"]);
    assert.match(out[0].detail, /"contact".*added/);
    assert.match(out[1].detail, /"quote-request".*modified/);
    assert.match(out[2].detail, /"old".*deleted/);
  });
  const rawCases = [
    ["<form> tag", "src/pages/a.astro", '<form action="/x" method="post">', ["raw_form"]],
    ["input", "src/content/pages/a.md", '<input type="text" name="q">', ["raw_form"]],
    ["select", "src/components/X.astro", "<select name=a>", ["raw_form"]],
    ["textarea uppercase", "src/pages/a.html", "<TEXTAREA></TEXTAREA>", ["raw_form"]],
    ["not a form element", "src/pages/a.astro", "<formatted>x</formatted> <inputs-list/>", []],
    ["inside src/guardhouse", "src/guardhouse/GuardhouseForm.astro", "<form><input></form>", []],
    ["plain text file ignored", "src/forms/notes.txt", "<form>", []],
  ];
  for (const [name, path, text, expected] of rawCases) {
    test(`raw_form: ${name}`, () => assert.deepEqual(rules([f(path, text)]).filter((r) => r === "raw_form"), expected));
  }
  test("raw_form only for newly added lines", () => {
    const old = '<form action="/x">';
    assert.deepEqual(rules([f("src/pages/a.astro", old + "\n<p>new</p>", old)]), []);
    assert.deepEqual(rules([f("src/pages/a.astro", old + "\n<input name=q>", old)]), ["raw_form"]);
  });
  test("binary and unknown file types are skipped", () => {
    assert.deepEqual(rules([f("public/uploads/a.jpg", "<script>")]), []);
  });
});

describe("changeSet (filesystem)", () => {
  async function tree(files) {
    const dir = await mkdtemp(join(tmpdir(), "cs-"));
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    return dir;
  }

  test("added, modified, deleted; ignores tooling dirs; no-op is empty", async () => {
    const base = await tree({ "src/pages/a.astro": "a", "src/pages/b.astro": "b", "src/pages/keep.astro": "k", ".git/HEAD": "x" });
    const edited = await tree({ "src/pages/a.astro": "A", "src/pages/keep.astro": "k", "src/pages/new.astro": "n", ".guardhouse/request.json": "{}", "node_modules/x/i.js": "1", "dist/i.html": "1", ".astro/t": "1", ".site-kit/x": "1" });
    const cs = await changeSet(base, edited);
    assert.deepEqual(cs.map((c) => [c.path, c.status]), [["src/pages/a.astro", "modified"], ["src/pages/b.astro", "deleted"], ["src/pages/new.astro", "added"]]);
    assert.equal(checkPolicy(cs, policy), null, "deletion inside editable paths is allowed");
    const same = await tree({ "src/pages/a.astro": "a", "src/pages/b.astro": "b", "src/pages/keep.astro": "k", ".guardhouse/request.json": "{}" });
    assert.deepEqual(await changeSet(base, same), []);
    assert.equal(checkPolicy(await changeSet(base, same), policy)?.reason, "no_changes");
  });

  test("a symlink in the edited tree is a violation; a pre-existing identical symlink is not a change", async () => {
    const base = await tree({ "src/pages/a.astro": "a" });
    const edited = await tree({ "src/pages/a.astro": "a" });
    await symlink("/etc/passwd", join(edited, "src/pages/evil"));
    const cs = await changeSet(base, edited);
    assert.deepEqual(cs.map((c) => [c.path, c.status]), [["src/pages/evil", "symlink"]]);
    assert.equal(checkPolicy(cs, policy)?.reason, "path_not_allowed");

    await symlink("/etc/passwd", join(base, "src/pages/evil"));
    assert.deepEqual(await changeSet(base, edited), []);
  });

  test("extraSymlinks (deleted by the edit job before upload) are reported", async () => {
    const base = await tree({ "src/pages/a.astro": "a" });
    const edited = await tree({ "src/pages/a.astro": "a" });
    const cs = await changeSet(base, edited, { extraSymlinks: ["src/pages/evil"] });
    assert.deepEqual(cs.map((c) => [c.path, c.status]), [["src/pages/evil", "symlink"]]);
    // A base symlink that the workspace copy lost is not reported as a deletion either.
    await symlink("x", join(base, "src/pages/old"));
    assert.deepEqual(await changeSet(base, edited, { extraSymlinks: ["src/pages/old"] }), []);
  });

  test("computePatchBytes ignores images and counts modified text by changed lines", async () => {
    const base = await tree({ "src/pages/a.astro": "line1\nline2\n" });
    const edited = await tree({ "src/pages/a.astro": "line1\nline2\nline3\n", "public/uploads/p.png": "x".repeat(1000), "public/doc.pdf": "y".repeat(300) });
    const cs = await changeSet(base, edited);
    assert.equal(await computePatchBytes(cs), 300 + 6);
  });
});
