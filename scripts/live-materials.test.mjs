import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { NextRequest, NextResponse } = require("next/server");

function loadModule(path, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    exports: module.exports, module, require: (name) => imports[name] ?? require(name),
    URL, URLSearchParams, Date, Buffer, process, console,
  });
  return module.exports;
}

const helpers = loadModule("../src/lib/live-classes/materials.ts");
const powerpoint = loadModule("../src/lib/server/live-material-powerpoint.ts");
const JSZip = require("jszip");

async function powerpointFixture({ count = 2, word = false } = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  if (word) zip.file("word/document.xml", "<document/>");
  else {
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="presentation"><p:sldIdLst>${Array.from({ length: count }, (_, i) => `<p:sldId id="${i + 1}"/>`).join("")}</p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", "<Relationships/>");
    for (let i = 1; i <= count; i++) zip.file(`ppt/slides/slide${i}.xml`, "<slide/>");
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

test("PowerPoint accepts PPTX and enforces its file-size limit", () => {
  assert.equal(helpers.getMaterialFileType("CLASE.PPTX", 50 * 1024 * 1024).kind, "powerpoint");
  assert.ok(helpers.MATERIAL_ACCEPT.includes(".pptx"));
  assert.throws(() => helpers.getMaterialFileType("clase.pptx", 51 * 1024 * 1024));
  assert.throws(() => helpers.getMaterialFileType("clase.ppt", 100));
});

test("PowerPoint validates the Office archive and rejects renamed Word, damaged or empty decks", async () => {
  assert.equal(await powerpoint.validatePowerPointArchive(await powerpointFixture()), 2);
  await assert.rejects(() => powerpoint.validatePowerPointArchive(Buffer.from("PK invalid zip")));
  await assert.rejects(async () => powerpoint.validatePowerPointArchive(await powerpointFixture({ word: true })));
  await assert.rejects(async () => powerpoint.validatePowerPointArchive(await powerpointFixture({ count: 0 })));
  await assert.rejects(async () => powerpoint.validatePowerPointArchive(await powerpointFixture({ count: 301 })));
});

test("YouTube links accept supported formats and reject disguised hosts or arbitrary content", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "https://youtu.be/dQw4w9WgXcQ",
    "https://m.youtube.com/shorts/dQw4w9WgXcQ", "https://youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ]) assert.equal(helpers.parseYouTubeId(url), "dQw4w9WgXcQ");
  for (const url of ["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "javascript:alert(1)", "https://example.com/video", "https://youtu.be/invalid", "https://youtube.com/watch?v=<script>"]) {
    assert.equal(helpers.parseYouTubeId(url), null);
  }
});

test("Google sharing links normalize native files, published views, selected tabs and resource keys", () => {
  const sheet = helpers.parseMaterialLink("https://docs.google.com/spreadsheets/d/Sheet_12345/edit?usp=sharing#gid=123");
  assert.equal(sheet.kind, "google_sheets");
  assert.equal(new URL(sheet.embedUrl).searchParams.get("gid"), "123");
  assert.equal(new URL(sheet.embedUrl).pathname, "/spreadsheets/d/Sheet_12345/preview");
  const slides = helpers.parseMaterialLink("https://docs.google.com/presentation/d/Slides_12345/edit#slide=id.g123_0_2");
  assert.equal(slides.kind, "google_slides");
  assert.equal(new URL(slides.embedUrl).hash, "#slide=id.g123_0_2");
  assert.equal(new URL(slides.embedUrl).searchParams.get("start"), "false");
  const published = helpers.parseMaterialLink("https://docs.google.com/spreadsheets/d/e/2PACX_example/pubhtml?gid=0&single=true");
  assert.equal(new URL(published.embedUrl).pathname, "/spreadsheets/d/e/2PACX_example/pubhtml");
  assert.equal(new URL(published.embedUrl).searchParams.get("gid"), "0");
  assert.equal(helpers.parseMaterialLink("https://docs.google.com/presentation/d/e/2PACX_example/pub").kind, "google_slides");
  assert.equal(helpers.parseMaterialLink("https://docs.google.com/document/u/1/d/Document_12345/edit").kind, "google_docs");
  assert.equal(new URL(helpers.parseMaterialLink("https://docs.google.com/document/d/e/2PACX_example/pub").embedUrl).searchParams.get("embedded"), "true");
  const drive = helpers.parseMaterialLink("https://drive.google.com/file/d/File_12345/view?resourcekey=0-secret_key&usp=sharing");
  assert.equal(drive.kind, "google_drive");
  assert.equal(new URL(drive.embedUrl).pathname, "/file/d/File_12345/preview");
  assert.equal(new URL(drive.embedUrl).searchParams.get("resourcekey"), "0-secret_key");
  assert.equal(helpers.parseMaterialLink("https://drive.google.com/open?id=File_12345").kind, "google_drive");
  assert.equal(helpers.parseMaterialLink("https://youtu.be/dQw4w9WgXcQ").kind, "youtube");
});

test("Google embeds reject arbitrary hosts, credentials, folders, scripts and unsupported apps", () => {
  for (const url of [
    "https://docs.google.com.evil.test/spreadsheets/d/Sheet_12345/edit",
    "https://drive.google.com.evil.test/file/d/File_12345/view",
    "https://docs.google.com@evil.test/spreadsheets/d/Sheet_12345/edit",
    "https://user:password@docs.google.com/spreadsheets/d/Sheet_12345/edit",
    "https://docs.google.com:8443/spreadsheets/d/Sheet_12345/edit",
    "javascript:alert(1)", "https://example.com/preview", "https://drive.google.com/drive/folders/Folder_12345",
    "https://docs.google.com/forms/d/Form_12345/edit", "https://docs.google.com/spreadsheets/d/x/edit",
  ]) assert.equal(helpers.parseGoogleMaterialLink(url), null, url);
});

test("files enforce format and size limits, including legacy Word and active SVG rejection", () => {
  assert.equal(helpers.getMaterialFileType("CLASE.PDF", 200).kind, "pdf");
  assert.equal(helpers.getMaterialFileType("video.mp4", 200 * 1024 * 1024).kind, "video");
  for (const [name, size] of [["x.pdf", 0], ["x.pdf", 21 * 1024 * 1024], ["x.docx", 11 * 1024 * 1024], ["x.mp4", Infinity], ["x.doc", 10], ["x.svg", 10], ["x.html", 10], ["constructor", 10], ["__proto__", 10]]) {
    assert.throws(() => helpers.getMaterialFileType(name, size));
  }
});

test("late joins calculate the current playback position using server time", () => {
  const state = { ...helpers.emptyPresentation(), position: 10, updatedAt: 1000, playing: true };
  assert.equal(helpers.presentationPosition(state, 6500), 15.5);
  assert.equal(helpers.presentationPosition({ ...state, playing: false }, 6500), 10);
  assert.equal(helpers.presentationPosition(state, 500), 10);
});

test("Word text divides into readable sections without dropping text", () => {
  const text = Array.from({ length: 200 }, (_, i) => `Párrafo ${i}: información para la clase.`).join("\n\n");
  const pages = helpers.splitWordText(text);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.throws(() => helpers.splitWordText("   "));
  assert.throws(() => helpers.splitWordText("a".repeat(200001)));
});

test("presentation controls reject malformed pages, playback flags and time offsets", () => {
  for (const input of [{ page: 0 }, { page: 1.5 }, { position: NaN }, { position: -1 }, { position: "3" }, { playing: "true" }]) {
    assert.throws(() => helpers.validatePresentationControl(input));
  }
  assert.equal(helpers.validatePresentationControl({ page: 2 }).page, 2);
});

class AccessError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function setup({ role = "teacher", status = "live", sessionKey = "session-1", denied = false } = {}) {
  const records = new Map();
  const files = new Map();
  let id = 0;
  const snapshot = (path) => ({ exists: records.has(path), data: () => records.get(path), get: (key) => records.get(path)?.[key] });
  const doc = (path) => ({
    path, id: path.split("/").at(-1), collection: (name) => collection(`${path}/${name}`),
    get: async () => snapshot(path), delete: async () => records.delete(path),
    update: async (data) => records.set(path, { ...records.get(path), ...data }),
  });
  const collection = (path, filter, limit = 100) => ({
    doc: (name = `material-${++id}`) => doc(`${path}/${name}`),
    where: (field, op, value) => collection(path, [field, op, value], limit),
    limit: (n) => collection(path, filter, n),
    get: async () => ({ docs: [...records.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/") && (!filter || (filter[1] === ">" ? records.get(key)[filter[0]] > filter[2] : records.get(key)[filter[0]] === filter[2]))).slice(0, limit).map((key) => ({ ...snapshot(key), id: key.split("/").at(-1) })) }),
  });
  const classPath = "courses/c/lessons/l/classes/k";
  const statePath = `${classPath}/liveMaterialState/current`;
  const materialPath = (materialId) => `${classPath}/liveMaterials/${materialId}`;
  const classRef = doc(classPath);
  const authCalls = [];
  const api = loadModule("../src/app/api/live/classes/[classId]/materials/route.ts", {
    "next/server": { NextResponse },
    "@/lib/live-classes/materials": helpers,
    "@/lib/server/live-material-powerpoint": powerpoint,
    "@/lib/live-classes/access": {
      LiveAccessError: AccessError,
      resolveAuthorizedLiveClassAccess: async (params) => {
        authCalls.push(params);
        if (denied || (params.requireTeacher && role !== "teacher")) throw new AccessError(403, "Sin permiso");
        return { user: { uid: "teacher-1" }, accessRole: role, classContext: { classRef, classId: "k", courseId: "c", lessonId: "l", liveSession: { status, lastStartedAt: sessionKey } } };
      },
      toLiveAccessErrorResponse: (error) => ({ status: error.status || 500, message: error.message }),
    },
    "@/lib/firebase/admin": {
      getAdminFirestore: () => ({ runTransaction: async (fn) => {
        const changes = [];
        await fn({ get: (ref) => ref.get(), create: (ref, data) => changes.push(() => records.set(ref.path, data)), set: (ref, data) => changes.push(() => records.set(ref.path, data)), delete: (ref) => changes.push(() => records.delete(ref.path)) });
        changes.forEach((apply) => apply());
      } }),
      getAdminApp: () => ({ options: { storageBucket: "test-bucket" }, storage: () => ({ bucket: () => ({ file: (path) => ({
        createResumableUpload: async () => ["https://storage.googleapis.com/upload-session"],
        getMetadata: async () => [files.get(path)?.metadata],
        download: async () => [files.get(path)?.content],
        delete: async () => files.delete(path),
      }) }) }) }),
    },
  });
  const request = async (body) => {
    const req = new NextRequest("http://localhost/api/live/classes/k/materials?courseId=c&lessonId=l", body ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : undefined);
    const response = await (body ? api.POST : api.GET)(req, { params: Promise.resolve({ classId: "k" }) });
    return { status: response.status, ...(await response.json()) };
  };
  const seed = (materialId, overrides = {}) => records.set(materialPath(materialId), { id: materialId, name: "Material", kind: "pdf", url: "https://storage.test/source", size: 10, createdAt: 1, status: "ready", uploadedBy: "teacher-1", ...overrides });
  return { request, seed, records, files, statePath, materialPath, authCalls };
}

test("students receive the active material only, without storage internals or the teacher's library", async () => {
  const app = setup({ role: "student" });
  app.seed("shared"); app.seed("private");
  app.records.set(app.statePath, { ...helpers.emptyPresentation("session-1"), materialId: "shared" });
  const response = await app.request();
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.materials, []);
  assert.equal(response.data.activeMaterial.id, "shared");
  assert.equal(response.data.activeMaterial.uploadedBy, undefined);
  assert.equal(response.data.activeMaterial.storagePath, undefined);
});

test("every mutation requires teacher authorization", async () => {
  const app = setup({ role: "student" });
  for (const action of ["upload", "complete", "youtube", "link", "delete", "present", "control", "stop"]) {
    assert.equal((await app.request({ action })).status, 403, action);
    assert.equal(app.authCalls.at(-1).requireTeacher, true);
  }
});

test("unauthorized viewers cannot read materials", async () => {
  assert.equal((await setup({ denied: true }).request()).status, 403);
});

test("a new session and an ended session never replay a prior presentation", async () => {
  for (const options of [{ sessionKey: "session-2" }, { status: "ended" }]) {
    const app = setup(options);
    app.seed("old");
    app.records.set(app.statePath, { ...helpers.emptyPresentation("session-1"), materialId: "old" });
    const response = await app.request();
    assert.equal(response.data.activeMaterial, null);
    assert.equal(response.data.materials.length, 1);
  }
});

test("presentation, page updates and stopping persist for later joins", async () => {
  const app = setup(); app.seed("pdf");
  assert.equal((await app.request({ action: "present", materialId: "pdf" })).status, 200);
  let response = await app.request();
  assert.equal(response.data.activeMaterial.id, "pdf");
  assert.equal((await app.request({ action: "control", materialId: "pdf", revision: response.data.presentation.revision, page: 3 })).status, 200);
  response = await app.request();
  assert.equal(response.data.presentation.page, 3);
  assert.equal((await app.request({ action: "stop" })).status, 200);
  assert.equal((await app.request()).data.activeMaterial, null);
});

test("stale controls cannot overwrite a newer material or presentation revision", async () => {
  const app = setup(); app.seed("a"); app.seed("b");
  await app.request({ action: "present", materialId: "a" });
  const old = (await app.request()).data.presentation;
  await app.request({ action: "present", materialId: "b" });
  assert.equal((await app.request({ action: "control", materialId: "a", revision: old.revision, page: 2 })).status, 409);
  assert.equal((await app.request()).data.activeMaterial.id, "b");
});

test("materials can be prepared before class, but cannot be presented until it starts", async () => {
  const app = setup({ status: "scheduled" });
  assert.equal((await app.request({ action: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", name: "Lección" })).status, 200);
  const source = (await app.request()).data.materials[0];
  assert.equal(source.name, "Lección");
  assert.equal((await app.request({ action: "present", materialId: source.id })).status, 409);
});

test("deleting a presented source stops sharing while keeping other library materials", async () => {
  const app = setup(); app.seed("a"); app.seed("b");
  await app.request({ action: "present", materialId: "a" });
  assert.equal((await app.request({ action: "delete", materialId: "a" })).status, 200);
  const response = await app.request();
  assert.equal(response.data.activeMaterial, null);
  assert.deepEqual(response.data.materials.map((item) => item.id), ["b"]);
});

test("incomplete uploads cannot be presented or exposed to students", async () => {
  const app = setup(); app.seed("pending", { status: "pending" });
  assert.equal((await app.request()).data.materials.length, 0);
  assert.equal((await app.request({ action: "present", materialId: "pending" })).status, 404);
});

test("uploaded files are finalized only after size, content type and signature verification", async () => {
  for (const valid of [true, false]) {
    const app = setup();
    app.seed("pending", { status: "pending", storagePath: "path", bucketName: "bucket", contentType: "application/pdf", size: 10 });
    app.files.set("path", { metadata: { size: 10, contentType: "application/pdf" }, content: Buffer.from(valid ? "%PDF-1.7xx" : "<html>xxxx") });
    const response = await app.request({ action: "complete", materialId: "pending" });
    assert.equal(response.status, valid ? 200 : 400);
    assert.equal((await app.request()).data.materials.length, valid ? 1 : 0);
  }
});

test("the material library enforces its limit", async () => {
  const app = setup();
  for (let i = 0; i < 50; i++) app.seed(`source-${i}`);
  assert.equal((await app.request({ action: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" })).status, 400);
});

test("PPTX finalization stores the slide count and rejects out-of-range navigation", async () => {
  const app = setup();
  const content = await powerpointFixture();
  const mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  app.seed("deck", { kind: "powerpoint", status: "pending", storagePath: "pptx", bucketName: "bucket", contentType: mime, size: content.length });
  app.files.set("pptx", { metadata: { size: content.length, contentType: mime }, content });
  assert.equal((await app.request({ action: "complete", materialId: "deck" })).status, 200);
  assert.equal((await app.request()).data.materials[0].slideCount, 2);
  await app.request({ action: "present", materialId: "deck" });
  const state = (await app.request()).data.presentation;
  assert.equal((await app.request({ action: "control", materialId: "deck", revision: state.revision, page: 3 })).status, 400);
  assert.equal((await app.request({ action: "control", materialId: "deck", revision: state.revision, page: 2 })).status, 200);
});

test("a Word archive renamed to PPTX is not published and its upload is removed", async () => {
  const app = setup();
  const content = await powerpointFixture({ word: true });
  const mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  app.seed("fake", { kind: "powerpoint", status: "pending", storagePath: "fake", bucketName: "bucket", contentType: mime, size: content.length });
  app.files.set("fake", { metadata: { size: content.length, contentType: mime }, content });
  assert.equal((await app.request({ action: "complete", materialId: "fake" })).status, 400);
  assert.equal((await app.request()).data.materials.length, 0);
  assert.equal(app.files.has("fake"), false);
});

test("Google Sheets and Slides can be added by URL and presented without uploading a copy", async () => {
  for (const [url, kind] of [
    ["https://docs.google.com/spreadsheets/d/Sheet_12345/edit#gid=42", "google_sheets"],
    ["https://docs.google.com/presentation/d/Slides_12345/edit", "google_slides"],
    ["https://docs.google.com/document/d/Document_12345/edit", "google_docs"],
    ["https://drive.google.com/file/d/File_12345/view", "google_drive"],
  ]) {
    const app = setup();
    const added = await app.request({ action: "link", url, name: "Material de Google" });
    assert.equal(added.status, 200);
    assert.equal(added.data.material.kind, kind);
    assert.equal(added.data.material.name, "Material de Google");
    assert.equal(added.data.material.size, 0);
    assert.equal(app.files.size, 0);
    assert.equal((await app.request({ action: "present", materialId: added.data.material.id })).status, 200);
    assert.equal((await app.request()).data.activeMaterial.kind, kind);
  }
});

test("link insertion enforces the library limit and rejects unsupported URLs", async () => {
  const app = setup();
  assert.equal((await app.request({ action: "link", url: "https://example.com/evil.html" })).status, 400);
  assert.equal((await app.request()).data.materials.length, 0);
  for (let i = 0; i < 50; i++) app.seed(`source-${i}`);
  assert.equal((await app.request({ action: "link", url: "https://docs.google.com/spreadsheets/d/Sheet_12345/edit" })).status, 400);
});
