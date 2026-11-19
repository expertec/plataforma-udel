import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-19T23:45:00.000Z";
const body = (changes = {}) => ({ source: "studentEnrollments", enrollmentId: "enrollment", courseId: "course",
  requestId: REQUEST_ID, revision: "1:0", newGrade: 90, reason: "Se revisó el acta original con nota 9/10.", ...changes });

function fixture({ role = "adminTeacher", plantelId = "campus", source = "studentEnrollments", legacy = false, failAudit = false,
  grade = 9, gradeScale, status = "closed" } = {}) {
  const before = { status, finalGrade: grade, autoGrade: 90, manualOverride: false, courseName: "Derecho",
    gradedAt: "2026-08-10T21:00:00Z", closedAt: "2026-08-11T21:00:00Z", closureDocumentUrl: "https://example.com/original.pdf",
    ...(gradeScale ? { gradeScale } : {}) };
  const records = new Map([
    ["users/actor", { role, displayName: "Directora", email: "director@example.com", plantelIds: ["campus"] }],
    ["users/student", { displayName: "Alumna" }],
    ["groups/group", { groupName: "Grupo A", plantelId }],
    ["courses/course", { title: "Derecho" }],
    [`${source}/enrollment`, { studentId: "student", studentName: "Alumna", groupId: "group",
      ...(legacy ? { "courseClosures.course": before } : { courseClosures: { course: before, other: { finalGrade: 80 } } }) }],
  ]);
  const versions = new Map([[`${source}/enrollment`, 1]]);
  const writes = [];
  const clone = value => Array.isArray(value) ? value.map(clone)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)])) : value;
  const resolve = value => value?.__serverTime ? { toDate: () => new Date(NOW) }
    : Array.isArray(value) ? value.map(resolve)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)])) : value;
  function ref(path) {
    return { path, id: path.split("/").at(-1), get: async () => snapshot(path) };
  }
  function snapshot(path) {
    return { ref: ref(path), id: path.split("/").at(-1), exists: records.has(path),
      data: () => records.has(path) ? clone(records.get(path)) : undefined,
      updateTime: { seconds: versions.get(path) || 1, nanoseconds: 0 } };
  }
  const db = {
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    runTransaction: async callback => {
      const pending = [];
      let writing = false;
      await callback({
        get: async reference => { assert.equal(writing, false, "Reads must precede all writes"); return snapshot(reference.path); },
        update: (reference, ...fields) => { writing = true; pending.push({ action: "update", reference, fields }); },
        create: (reference, data) => { writing = true; pending.push({ action: "create", reference, data }); },
      });
      if (failAudit && pending.some(item => item.action === "create")) throw new Error("Audit write failed");
      for (const item of pending) {
        if (item.action === "create") {
          assert.equal(records.has(item.reference.path), false, "Audit records cannot be overwritten");
          records.set(item.reference.path, resolve(item.data));
        } else {
          const data = clone(records.get(item.reference.path));
          for (let i = 0; i < item.fields.length; i += 2) {
            const segments = item.fields[i].segments;
            let target = data;
            for (const key of segments.slice(0, -1)) { target[key] ||= {}; target = target[key]; }
            const key = segments.at(-1), value = item.fields[i + 1];
            if (value?.__delete) delete target[key]; else target[key] = resolve(value);
          }
          records.set(item.reference.path, data);
          versions.set(item.reference.path, (versions.get(item.reference.path) || 1) + 1);
        }
      }
      writes.push(...pending);
    },
  };
  class TeacherAccessError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const modules = new Map();
  function load(name) {
    if (name === "firebase-admin/firestore") return {
      FieldPath: class { constructor(...segments) { this.segments = segments; } },
      FieldValue: { serverTimestamp: () => ({ __serverTime: true }), delete: () => ({ __delete: true }) },
    };
    if (name === "@/lib/firebase/admin") return { getAdminFirestore: () => db };
    if (name === "@/lib/server/require-teacher-access") return { TeacherAccessError };
    if (modules.has(name)) return modules.get(name);
    const code = fs.readFileSync(new URL(`../${name.replace("@/", "src/")}.ts`, import.meta.url), "utf8");
    const ctx = { exports: {}, require: load };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
    modules.set(name, ctx.exports);
    return ctx.exports;
  }
  const api = load("@/lib/server/grade-scale-corrections");
  const actor = { uid: "actor", role, email: "director@example.com", displayName: "Directora" };
  return { records, writes, before, parse: api.parseGradeCorrection,
    save: (changes = {}, actorChanges = {}) => api.correctGradeScale({ ...actor, ...actorChanges },
      api.parseGradeCorrection(body({ source, ...changes })),
      { userAgent: "Test browser", forwardedFor: "reported-client-address", requestTrace: "trace" }) };
}

test("correction and full audit are saved atomically with trusted actor and server time", async () => {
  const f = fixture();
  const result = await f.save({ actorId: "spoofed", correctedAt: "2000-01-01" });
  const updated = f.records.get("studentEnrollments/enrollment").courseClosures;
  const event = f.records.get(`gradeScaleCorrections/${REQUEST_ID}`);
  assert.equal(updated.course.finalGrade, 90);
  assert.equal(updated.course.gradeScale, 100);
  assert.equal(updated.course.manualOverride, true);
  assert.equal(updated.other.finalGrade, 80);
  assert.equal(updated.course.gradedAt, f.before.gradedAt);
  assert.equal(updated.course.closedAt, f.before.closedAt);
  assert.equal(updated.course.closureDocumentUrl, f.before.closureDocumentUrl);
  assert.equal(event.before.finalGrade, 9);
  assert.equal(event.after.finalGrade, 90);
  assert.equal(event.actorId, "actor");
  assert.equal(event.actorRole, "adminTeacher");
  assert.equal(event.actorEmail, "director@example.com");
  assert.equal(event.requestMetadata.userAgent, "Test browser");
  assert.equal(result.correctedAt, NOW);
  assert.equal(result.id, REQUEST_ID);
});

test("audit failure leaves the original grade unchanged", async () => {
  const f = fixture({ failAudit: true });
  await assert.rejects(f.save(), /Audit write failed/);
  assert.equal(f.records.get("studentEnrollments/enrollment").courseClosures.course.finalGrade, 9);
  assert.equal(f.records.has(`gradeScaleCorrections/${REQUEST_ID}`), false);
});

test("a director can correct an assigned campus but cannot correct another campus", async () => {
  await fixture({ role: "director" }).save();
  const f = fixture({ role: "director", plantelId: "other" });
  await assert.rejects(f.save(), error => error.status === 403);
  assert.equal(f.writes.length, 0);
});

test("permissions are read again in the transaction and ordinary teachers are denied", async () => {
  const f = fixture();
  f.records.set("users/actor", { role: "teacher" });
  await assert.rejects(f.save(), error => error.status === 403);
  assert.equal(f.writes.length, 0);
});

test("stale analyses, already-normalized grades and open closures cannot be corrected", async () => {
  for (const [options, changes] of [[{}, { revision: "2:0" }], [{ gradeScale: 100 }, {}], [{ grade: 90 }, {}], [{ status: "open" }, {}]]) {
    const f = fixture(options);
    await assert.rejects(f.save(changes), error => error.status === 409);
    assert.equal(f.writes.length, 0);
  }
});

test("retries return the same correction instead of writing a duplicate", async () => {
  const f = fixture();
  const first = await f.save();
  const second = await f.save();
  assert.equal(first.id, second.id);
  assert.equal(f.writes.filter(item => item.action === "create").length, 1);
  await assert.rejects(f.save({ newGrade: 95 }), error => error.status === 409);
});

test("archived and dotted legacy closures retain an audit and normalize without stale duplicates", async () => {
  const f = fixture({ source: "studentEnrollmentsArchive", legacy: true });
  const result = await f.save();
  const data = f.records.get("studentEnrollmentsArchive/enrollment");
  assert.equal(data.courseClosures.course.finalGrade, 90);
  assert.equal(Object.hasOwn(data, "courseClosures.course"), false);
  assert.equal(result.source, "studentEnrollmentsArchive");
  assert.equal(f.records.get(`gradeScaleCorrections/${REQUEST_ID}`).before.finalGrade, 9);
});

test("invalid grades, references, reasons and unversioned requests are rejected", () => {
  const f = fixture();
  for (const changes of [{ newGrade: -1 }, { newGrade: 101 }, { newGrade: NaN }, { newGrade: "90" },
    { newGrade: 90.123 }, { reason: "" }, { reason: "short" }, { reason: "a".repeat(2001) },
    { source: "users" }, { enrollmentId: "a/b" }, { courseId: "" }, { requestId: "a/b" }, { revision: "" }]) {
    assert.throws(() => f.parse(body(changes)), error => error.status === 400);
  }
  assert.equal(f.parse(body({ newGrade: 89.75 })).newGrade, 89.75);
});
