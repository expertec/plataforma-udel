import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/lib/students/grade-scale-analysis.ts", import.meta.url), "utf8");
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { analyzeEnrollmentGradeScale } = context.exports;
const enrollment = (changes = {}) => ({ courseClosures: { course: {
  status: "closed", finalGrade: 9, courseName: "Derecho", ...changes,
} } });

test("flags possible ten-point finals without converting the stored grade", () => {
  const data = enrollment();
  const [row] = analyzeEnrollmentGradeScale(data);
  assert.equal(row.grade, 9);
  assert.equal(row.suggestedGrade, 90);
  assert.equal(row.priority, "review");
  assert.match(row.reasons.join(" "), /nota baja real/);
  assert.equal(data.courseClosures.course.finalGrade, 9);
});

test("prioritizes explicit scales and conversions matching the automatic result", () => {
  assert.equal(analyzeEnrollmentGradeScale(enrollment({ gradeScale: 10 }))[0].priority, "high");
  const [row] = analyzeEnrollmentGradeScale(enrollment({ finalGrade: 9.5, autoGrade: 95 }));
  assert.equal(row.suggestedGrade, 95);
  assert.equal(row.priority, "high");
  assert.match(row.reasons.join(" "), /coincide con el cálculo automático/);
});

test("a passing automatic grade is evidence rather than proof of a scale conversion", () => {
  const [row] = analyzeEnrollmentGradeScale(enrollment({ finalGrade: 8, autoGrade: 99, manualOverride: true }));
  assert.equal(row.priority, "review");
  assert.match(row.reasons.join(" "), /99\/100/);
  assert.match(row.reasons.join(" "), /manualmente/);
});

test("does not flag confirmed 100-scale grades, normalized imports, zeros or invalid grades", () => {
  for (const changes of [{ gradeScale: 100 }, { academicHistoryId: "history" }, { equivalencyId: "eq" },
    { status: "open" }, { finalGrade: 0 }, { finalGrade: 70 }, { finalGrade: -1 }, { finalGrade: 10.1 },
    { finalGrade: NaN }, { finalGrade: null }, { finalGrade: Infinity }]) {
    assert.equal(analyzeEnrollmentGradeScale(enrollment(changes)).length, 0);
  }
});

test("handles legacy dotted closure fields without duplicating nested records", () => {
  const data = enrollment();
  data["courseClosures.course"] = { status: "closed", finalGrade: 7 };
  data["courseClosures.legacy"] = { status: "closed", finalGrade: 8 };
  const rows = analyzeEnrollmentGradeScale(data);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.courseId === "course").grade, 9);
  assert.equal(rows.find(row => row.courseId === "legacy").suggestedGrade, 80);
});

test("does not inspect quiz scores or other non-final grade fields", () => {
  assert.equal(analyzeEnrollmentGradeScale({ submissions: [{ grade: 9 }], finalGrade: 8 }).length, 0);
  assert.equal(analyzeEnrollmentGradeScale({ courseClosures: null }).length, 0);
});

test("keeps grading and closing dates separate and serializes Firestore timestamps", () => {
  const [row] = analyzeEnrollmentGradeScale(enrollment({
    gradedAt: { toDate: () => new Date("2026-11-19T22:30:00Z") },
    closedAt: "2026-11-20T01:00:00Z",
  }));
  assert.equal(row.gradedAt, "2026-11-19T22:30:00.000Z");
  assert.equal(row.closedAt, "2026-11-20T01:00:00.000Z");
  const [legacy] = analyzeEnrollmentGradeScale(enrollment({ closedAt: "2026-11-20T01:00:00Z" }));
  assert.equal(legacy.gradedAt, null, "Closing time must not be presented as grading time");
  assert.equal(legacy.closedAt, "2026-11-20T01:00:00.000Z");
  const [invalid] = analyzeEnrollmentGradeScale(enrollment({ gradedAt: "invalid", closedAt: null }));
  assert.equal(invalid.gradedAt, null);
  assert.equal(invalid.closedAt, null);
});

function routeFixture({ authorized = true, role = "adminTeacher", records = [], groups = [], metadata = {} } = {}) {
  const reads = [];
  const modules = new Map();
  const db = {
    doc: path => ({ path }),
    collection: name => {
      let cursor = "", limit;
      const filters = [];
      const query = {
        doc: id => ({ path: `${name}/${id}`, get: async () => ({ data: () => metadata[`${name}/${id}`] }) }),
        where: (field, operator, value) => { assert.equal(operator, "=="); filters.push([field, value]); return query; },
        orderBy: () => query,
        limit: value => { limit = value; return query; },
        startAfter: value => { cursor = value; return query; },
        get: async () => {
          reads.push({ name, cursor, limit, filters });
          const docs = (name === "groups" ? groups : records).filter(row => row.id > cursor &&
            filters.every(([field, value]) => row.data[field] === value))
            .slice(0, limit ?? Infinity).map(row => ({ id: row.id, data: () => row.data,
              updateTime: { seconds: 123, nanoseconds: 456 } }));
          return { docs, size: docs.length };
        },
      };
      return query;
    },
    getAll: async (...refs) => refs.map(ref => ({ ref, data: () => metadata[ref.path] })),
  };
  function load(name) {
    if (name === "next/server") return { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200 }) } };
    if (name === "firebase-admin/firestore") return { FieldPath: { documentId: () => "__name__" } };
    if (name === "@/lib/firebase/admin") return { getAdminFirestore: () => db };
    if (name === "@/lib/server/require-teacher-access") {
      class TeacherAccessError extends Error {
        constructor(status, message) { super(message); this.status = status; }
      }
      return {
        TeacherAccessError,
        requireTeacherAccess: async () => {
          if (!authorized) throw new TeacherAccessError(403, "Forbidden");
          return { uid: "viewer", role };
        },
        toTeacherAccessErrorResponse: error => ({ status: error.status || 500 }),
      };
    }
    if (modules.has(name)) return modules.get(name);
    const code = fs.readFileSync(new URL(`../${name.replace("@/", "src/")}.ts`, import.meta.url), "utf8");
    const ctx = { exports: {}, require: load };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, ctx);
    modules.set(name, ctx.exports);
    return ctx.exports;
  }
  const { GET } = load("@/app/api/admin/grade-scale-analysis/route");
  return {
    reads, get: (query = "") => GET({ nextUrl: new URL(`https://example.com/api?${query}`) }),
    getHistory: (query = "") => load("@/app/api/admin/grade-scale-analysis/corrections/route").GET({
      nextUrl: new URL(`https://example.com/api?${query}`),
    }),
  };
}

test("route refuses unauthorized analysis before reading student records", async () => {
  const f = routeFixture({ authorized: false });
  assert.equal((await f.get()).status, 403);
  assert.equal(f.reads.length, 0);
});

test("route validates source and cursor, and resolves candidate names", async () => {
  const f = routeFixture({ records: [{ id: "a", data: { ...enrollment(), studentId: "s", groupId: "g" } }],
    metadata: { "users/s": { displayName: "Alumna" }, "groups/g": { groupName: "Grupo A" } } });
  assert.equal((await f.get("source=users")).status, 400);
  assert.equal((await f.get("after=a/b")).status, 400);
  assert.equal(f.reads.length, 0);
  const result = await f.get();
  assert.equal(result.body.data.rows[0].studentName, "Alumna");
  assert.equal(result.body.data.rows[0].groupName, "Grupo A");
  assert.equal(result.body.data.rows[0].revision, "123:456");
  assert.equal(result.body.data.nextCursor, null);
});

test("route pages scans even when a full page has no findings, including archives", async () => {
  const f = routeFixture({ records: Array.from({ length: 201 }, (_, i) => ({ id: String(i).padStart(3, "0"), data: {} })) });
  const first = await f.get("source=studentEnrollmentsArchive");
  assert.equal(first.body.data.scanned, 200);
  assert.equal(first.body.data.rows.length, 0);
  assert.equal(first.body.data.nextCursor, "199");
  const last = await f.get("source=studentEnrollmentsArchive&after=199");
  assert.equal(last.body.data.scanned, 1);
  assert.equal(last.body.data.nextCursor, null);
  assert.equal(f.reads[0].name, "studentEnrollmentsArchive");
});

test("directors only scan their campus groups and assigned online groups, including archives", async () => {
  const f = routeFixture({ role: "director", metadata: { "users/viewer": { plantelIds: ["campus"] } },
    groups: [
      { id: "a", data: { plantelId: "campus" } },
      { id: "b", data: { plantelId: "other", coordinatorId: "viewer", isInPerson: false } },
      { id: "c", data: { plantelId: "other", coordinatorId: "viewer", isInPerson: true } },
      { id: "d", data: { plantelId: "other" } },
    ],
    records: ["a", "b", "c", "d"].map(groupId => ({ id: groupId, data: { ...enrollment(), groupId, studentId: "student" } })),
  });
  for (const source of ["studentEnrollments", "studentEnrollmentsArchive"]) {
    const first = await f.get(`source=${source}`);
    assert.equal(first.body.data.rows.length, 1);
    assert.equal(first.body.data.rows[0].groupId, "a");
    assert.equal(first.body.data.scanned, 1);
    assert.equal(first.body.data.nextGroupOffset, 1);
    const last = await f.get(`source=${source}&groupOffset=1`);
    assert.equal(last.body.data.rows[0].groupId, "b");
    assert.equal(last.body.data.nextGroupOffset, null);
    const forged = await f.get(`source=${source}&groupOffset=2&groupId=d`);
    assert.equal(forged.body.data.rows.length, 0);
    assert.equal(forged.body.data.scanned, 0);
  }
});

test("directors with no assignments get empty results without scanning enrollments", async () => {
  const f = routeFixture({ role: "director", records: [{ id: "a", data: enrollment() }] });
  const result = await f.get();
  assert.equal(result.body.data.rows.length, 0);
  assert.equal(result.body.data.scanned, 0);
  assert.equal(f.reads.some(read => read.name.startsWith("studentEnrollments")), false);
});

test("legacy campus assignment and coordinator director extra-role are respected", async () => {
  for (const directorRole of [{ extraRoles: ["director"] }, { extraRoles: { director: true } }, { directorEnabled: true }]) {
    const f = routeFixture({ role: "coordinadorPlantel", metadata: { "users/viewer": { plantelId: "campus", ...directorRole } },
      groups: [{ id: "a", data: { plantelId: "campus" } }],
      records: [{ id: "x", data: { ...enrollment(), groupId: "a" } }],
    });
    assert.equal((await f.get()).body.data.rows.length, 1);
  }
  for (const role of ["teacher", "coordinadorPlantel"]) {
    const f = routeFixture({ role });
    assert.equal((await f.get()).status, 403);
    assert.equal(f.reads.some(read => read.name.startsWith("studentEnrollments")), false);
  }
});

test("scoped pagination stays inside the allowed group across full pages", async () => {
  const f = routeFixture({ role: "director", metadata: { "users/viewer": { plantelIds: ["campus"] } },
    groups: [{ id: "a", data: { plantelId: "campus" } }, { id: "b", data: { plantelId: "campus" } }],
    records: Array.from({ length: 201 }, (_, i) => ({ id: String(i).padStart(3, "0"), data: { groupId: "a" } })),
  });
  const first = (await f.get()).body.data;
  assert.equal(first.nextCursor, "199");
  assert.equal(first.nextGroupOffset, 0);
  const second = (await f.get("after=199&groupOffset=0")).body.data;
  assert.equal(second.scanned, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(second.nextGroupOffset, 1);
  assert.equal((await f.get("groupOffset=1")).body.data.nextGroupOffset, null);
  assert.equal((await f.get("groupOffset=-1")).status, 400);
});

test("correction history keeps directors in scope and exposes actor and time without raw snapshots", async () => {
  const event = { studentName: "Alumna", previousGrade: 9, newGrade: 90, correctedAt: "2026-11-19T22:00:00Z",
    actorId: "admin", actorName: "Administración", actorEmail: "admin@example.com", reason: "Acta revisada",
    before: { privateSnapshot: true }, after: { privateSnapshot: true } };
  const f = routeFixture({ role: "director", metadata: { "users/viewer": { plantelIds: ["campus"] } },
    groups: [{ id: "a", data: { plantelId: "campus" } }],
    records: [{ id: "one", data: { ...event, groupId: "a" } }, { id: "two", data: { ...event, groupId: "other" } }],
  });
  const response = await f.getHistory();
  assert.equal(response.body.data.rows.length, 1);
  assert.equal(response.body.data.rows[0].id, "one");
  assert.equal(response.body.data.rows[0].actorName, "Administración");
  assert.equal(response.body.data.rows[0].correctedAt, "2026-11-19T22:00:00.000Z");
  assert.equal("before" in response.body.data.rows[0], false);
  assert.equal(response.body.data.nextGroupOffset, null);
  const denied = routeFixture({ authorized: false });
  assert.equal((await denied.getHistory()).status, 403);
  assert.equal(denied.reads.length, 0);
});
