import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, imports = {}, fetcher = () => { throw new Error("Unexpected network call"); }) {
  const loadedModule = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, require: (name) => imports[name] ?? require(name), URL, URLSearchParams, AbortSignal, TextDecoder, fetch: fetcher });
  return loadedModule.exports;
}
const materials = load("../src/lib/live-classes/materials.ts");
const service = (fetcher) => load("../src/lib/server/live-material-title.ts", { "@/lib/live-classes/materials": materials }, fetcher);
const html = (content, status = 200) => new Response(content, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

test("HTML metadata extracts real names and decodes entities without returning login or product titles", () => {
  const titles = service();
  assert.equal(titles.extractMaterialHtmlTitle('<title>Fallback - Google Docs</title><META CONTENT="Álgebra &amp; Física – Google Slides" PROPERTY="og:title">'), "Álgebra & Física");
  assert.equal(titles.extractMaterialHtmlTitle("<title>Presupuesto &#39;2026&#39; - Google Sheets</title>"), "Presupuesto '2026'");
  assert.equal(titles.extractMaterialHtmlTitle('<meta name="twitter:title" content="Introducción a Excel">'), "Introducción a Excel");
  assert.equal(titles.extractMaterialHtmlTitle("<title>Sign in - Google Accounts</title>"), null);
  assert.equal(titles.extractMaterialHtmlTitle("<title>Google Slides</title>"), null);
  assert.equal(titles.cleanMaterialTitle("a".repeat(500)).length, 180);
});

test("YouTube title resolution uses public oEmbed metadata and caches concurrent lookups", async () => {
  let calls = 0;
  const titles = service(async (url, options) => {
    calls += 1;
    const target = new URL(url);
    assert.equal(target.origin, "https://www.youtube.com");
    assert.equal(target.pathname, "/oembed");
    assert.equal(target.searchParams.get("url"), "https://www.youtube.com/watch?v=yo7PplZjjUY");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    return Response.json({ title: "how to actually use a Boss DS-1." });
  });
  const result = await Promise.all([titles.resolveMaterialLinkTitle("https://youtu.be/yo7PplZjjUY"), titles.resolveMaterialLinkTitle("https://www.youtube.com/watch?v=yo7PplZjjUY")]);
  assert.deepEqual(result, ["how to actually use a Boss DS-1.", "how to actually use a Boss DS-1."]);
  assert.equal(await titles.resolveMaterialLinkTitle("https://youtu.be/yo7PplZjjUY"), result[0]);
  assert.equal(calls, 1);
});

test("Google document names are extracted from public HTML and product suffixes are removed", async () => {
  const titles = service(async (url) => {
    assert.equal(new URL(url).hostname, "docs.google.com");
    return html('<meta property="og:title" content="Plan de clase &amp; ejercicios - Google Slides">');
  });
  assert.equal(await titles.resolveMaterialLinkTitle("https://docs.google.com/presentation/d/Slides_12345/edit"), "Plan de clase & ejercicios");
});

test("invalid URLs and external or sign-in redirects never trigger arbitrary network requests", async () => {
  let calls = 0;
  const titles = service(async () => { calls += 1; return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }); });
  assert.equal(await titles.resolveMaterialLinkTitle("https://example.com/file"), null);
  assert.equal(await titles.resolveMaterialLinkTitle("https://docs.google.com.evil.test/document/d/File_12345/edit"), null);
  assert.equal(calls, 0);
  assert.equal(await titles.resolveMaterialLinkTitle("https://docs.google.com/document/d/File_12345/edit"), null);
  assert.equal(calls, 1);
  let loginCalls = 0;
  const login = service(async () => { loginCalls += 1; return new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/ServiceLogin" } }); });
  assert.equal(await login.resolveMaterialLinkTitle("https://docs.google.com/document/d/File_12345/edit"), null);
  assert.equal(loginCalls, 1);
});

test("provider failures and private files return no title without preventing link insertion", async () => {
  const denied = service(async () => html("Access denied", 403));
  assert.equal(await denied.resolveMaterialLinkTitle("https://drive.google.com/file/d/File_12345/view"), null);
  const offline = service(async () => { throw new Error("Network unavailable"); });
  assert.equal(await offline.resolveMaterialLinkTitle("https://youtu.be/yo7PplZjjUY"), null);
});

test("large pages are bounded and same-provider redirects retain title discovery", async () => {
  let calls = 0;
  const titles = service(async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { status: 302, headers: { Location: "https://docs.google.com/document/d/File_12345/preview" } });
    return html("<title>Guía del curso - Google Docs</title>" + "x".repeat(1024 * 1024));
  });
  assert.equal(await titles.resolveMaterialLinkTitle("https://docs.google.com/document/d/File_12345/edit"), "Guía del curso");
  assert.equal(calls, 2);
});
