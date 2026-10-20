import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = new Map();
const input = (changes = {}) => ({
  courseId: "course", courseName: "Derecho", groupId: null, groupName: "LPI2023",
  cycle: "2024-2", semester: "4", section: "academic", accreditationType: "ordinary",
  grade: 8.5, gradeScale: 10, registeredAt: "2026-10-17", notes: "Expediente físico", ...changes,
});

// Runs the actual model, services and route handlers with an isolated Firestore.
// Pending writes commit only when the complete transaction succeeds.
function fixture(role = "adminTeacher", uid = "admin") {
  const records = new Map([
    ["users/admin", { role, plantelIds: ["campus"] }],
    ["users/student", { role: "student", plantelIds: ["campus"], archivedPlantelIds: ["old-campus"] }],
    ["courses/course", { title: "Derecho" }],
    ["courses/other", { title: "Historia" }],
    ["groups/group", { groupName: "LPI2023", semester: "4", plantelId: "campus" }],
  ]);
  let nextId = 0;
  let writes = 0;
  let reads = 0;
  const snapshot = (documentPath) => ({
    id: documentPath.split("/").at(-1), exists: records.has(documentPath),
    data: () => records.get(documentPath), ref: document(documentPath),
  });
  function document(documentPath) {
    return { path: documentPath, get: async () => snapshot(documentPath), collection: (name) => collection(`${documentPath}/${name}`) };
  }
  function collection(collectionPath, filters = []) {
    return {
      doc: (id = `generated-${++nextId}`) => document(`${collectionPath}/${id}`),
      where: (field, operator, value) => {
        assert.equal(operator, "==");
        return collection(collectionPath, [...filters, [field, value]]);
      },
      get: async () => {
        const docs = [...records.keys()].filter((key) =>
          key.startsWith(`${collectionPath}/`) && key.split("/").length === collectionPath.split("/").length + 1 &&
          filters.every(([field, value]) => records.get(key)[field] === value),
        ).map(snapshot);
        return { docs, empty: docs.length === 0 };
      },
    };
  }
  const db = {
    collection,
    runTransaction: async (callback) => {
      const pending = [];
      await callback({
        get: (ref) => { assert.equal(pending.length, 0, "Firestore requires all reads before writes"); reads++; return ref.get(); },
        set: (ref, data) => pending.push([ref.path, data]),
        create: (ref, data) => { assert.equal(records.has(ref.path), false); pending.push([ref.path, data]); },
      });
      for (const [key, value] of pending) { records.set(key, value); writes++; }
    },
  };
  const modules = new Map();
  const dependencies = {
    "firebase-admin/firestore": { FieldValue: { serverTimestamp: () => "server-timestamp" } },
    "@/lib/firebase/admin": {
      getAdminFirestore: () => db,
      getAdminAuth: () => ({ verifyIdToken: async (token) => {
        if (token !== "valid") throw new Error("invalid token");
        return { uid, role };
      } }),
    },
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
  };
  const load = (name, parent = root) => {
    if (dependencies[name]) return dependencies[name];
    const filename = name.startsWith("@/") ? path.join(root, "src", `${name.slice(2)}.ts`) : path.resolve(path.dirname(parent), `${name}.ts`);
    if (modules.has(filename)) return modules.get(filename).exports;
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText);
    const loadedModule = { exports: {} };
    modules.set(filename, loadedModule);
    vm.runInNewContext(compiled.get(filename), {
      exports: loadedModule.exports, module: loadedModule, console, Date, Intl,
      require: (dependency) => load(dependency, filename),
    }, { filename });
    return loadedModule.exports;
  };
  const model = load("@/lib/students/academic-history");
  const kardex = load("@/lib/students/kardex");
  const server = load("@/lib/server/student-academic-history");
  const equivalents = load("@/lib/server/student-equivalencies");
  const studentAccess = { uid: "student", role: "student", plantelIds: [] };
  const sdkSnapshot = (snap) => ({ ...snap, exists: () => snap.exists });
  Object.assign(dependencies, {
    "firebase/firestore": {
      collection: (_db, name) => ({ name }),
      doc: (_db, name, id) => ({ name, id }),
      where: (field, operator, value) => ({ field, operator, value }),
      query: (ref, filter) => ({ ref, filter }),
      getDocs: async ({ ref, filter }) => collection(ref.name).where(filter.field, filter.operator, filter.value).get(),
      getDoc: async ({ name, id }) => sdkSnapshot(snapshot(`${name}/${id}`)),
    },
    "@/lib/firebase/firestore": { db: {} },
    "./gating": { trimSafeString: (value) => typeof value === "string" ? value.trim() : "" },
    "@/lib/firebase/academic-history-service": { getStudentAcademicHistory: (id) => server.readStudentAcademicHistory(id, studentAccess) },
    "@/lib/firebase/equivalencies-service": { getStudentEquivalencies: (id) => equivalents.readStudentEquivalencies(id, studentAccess) },
  });
  const route = load("@/app/api/students/[studentId]/academic-history/route");
  const gradesRoute = load("@/app/api/students/[studentId]/grades/route");
  const access = { uid, role, plantelIds: ["campus"] };
  const request = (method, body, token = "valid", query = "") => route[method]({
    method, headers: new Headers(token ? { Authorization: `Bearer ${token}` } : {}),
    nextUrl: new URL(`https://example.test/api/students/student/academic-history${query}`),
    json: async () => body,
  }, { params: Promise.resolve({ studentId: "student" }) });
  return {
    model, kardex, server, equivalents, access, records, request, writes: () => writes, reads: () => reads,
    create: (entries = [input()]) => request("POST", { entries }),
    list: async (history = false) => (await (await request("GET", null, "valid", history ? "?history=1" : "")).json()).data.records,
    grades: () => gradesRoute.GET({ headers: new Headers({ Authorization: "Bearer valid" }) }, { params: Promise.resolve({ studentId: "student" }) }),
    studentKardex: () => load("@/app/aula/_lib/kardex"),
  };
}

test("historical grades include zero and failing scores and normalize both scales", () => {
  const { model } = fixture();
  for (const [grade, gradeScale, expected] of [[0, 10, 0], [6, 10, 60], [8.5, 10, 85], [87.5, 100, 87.5]]) {
    assert.equal(model.academicHistoryFinalGrade(model.validateAcademicHistoryInput(input({ grade, gradeScale }))), expected);
  }
  for (const change of [{ grade: -1 }, { grade: 11 }, { grade: NaN }, { grade: "8" }, { gradeScale: 20 },
    { registeredAt: "2025-02-29" }, { registeredAt: "2026-02-30" }, { registeredAt: "M-17/10/2026" },
    { courseId: "../bad" }, { groupId: "a/b" }, { courseName: " " }, { groupName: "" }, { cycle: "" },
    { semester: "0" }, { semester: "4.5" }, { section: "unknown" }, { accreditationType: "unknown" }]) {
    assert.throws(() => model.validateAcademicHistoryInput(input(change)), JSON.stringify(change));
  }
  assert.equal(model.validateAcademicHistoryInput(input({ registeredAt: "2024-02-29" })).registeredAt, "2024-02-29");
});

test("manual date, cycle, section and exam type survive conversion to all kardex rows", () => {
  const { model, kardex } = fixture();
  for (const accreditationType of ["ordinary", "extraordinary", "global"]) {
    const row = model.academicHistoryGradeRow({ ...input({ accreditationType }), id: "record", finalGrade: 85, updatedAt: "2026-10-19T15:00:00Z" });
    assert.equal(row.finalGrade, 85);
    assert.equal(kardex.kardexOrdinaryGrade(row), accreditationType === "ordinary" ? 85 : null);
    assert.equal(row.extraordinaryExamGrade, accreditationType === "extraordinary" ? 85 : null);
    assert.equal(row.globalExamGrade, accreditationType === "global" ? 85 : null);
    assert.match(kardex.formatKardexIdentification(row), /Ciclo: 2024-2/);
    assert.match(kardex.formatKardexIdentification(row), /M-17\/10\/2026/);
    assert.equal(kardex.getKardexSection({ ...row, groupName: "CERT. Histórico" }), "academic");
    assert.equal(kardex.getKardexSection({ ...row, section: "certifications", isCertification: true }), "certifications");
  }
  assert.equal(model.formatManualRegistrationDate("2026-10-17"), "M-17/10/2026");
  assert.equal(model.formatManualRegistrationDate(undefined), "—");
  assert.equal(kardex.formatKardexIdentification({ groupName: "Grupo", semester: "4", updatedAt: new Date("2026-10-17T12:00:00Z") }), "G. Grupo | C. 4 | A. 17/10/26");
  assert.equal(kardex.getKardexSection({ groupName: "CERT. Inglés" }), "certifications");
  assert.equal(kardex.getKardexSection({ groupName: "CERT. Institución", equivalencyId: "equivalent" }), "academic");
});

test("program progress counts unique passed catalog subjects, excluding manual names and certifications", () => {
  const { kardex, model } = fixture();
  const row = model.academicHistoryGradeRow({ ...input(), id: "record", finalGrade: 85 });
  assert.equal(kardex.countProgramApproved([
    row, { ...row, id: "recursamiento", cycle: "2025-1" }, { ...row, courseId: "other", finalGrade: 60 },
    { ...row, courseId: "certification", section: "certifications" },
    { ...row, courseId: "", countsTowardProgram: false },
    { ...row, courseId: "open", status: "open" },
  ]), 1);
});

test("unauthenticated and unauthorized mutations cannot write", async () => {
  const app = fixture();
  assert.equal((await app.request("POST", { entries: [input()] }, null)).status, 401);
  assert.equal((await app.request("POST", { entries: [input()] }, "expired")).status, 401);
  assert.equal(app.writes(), 0);
  for (const role of ["student", "teacher", "director", "coordinadorPlantel"]) {
    const other = fixture(role, role === "student" ? "student" : "admin");
    assert.equal((await other.create()).status, 403, role);
    assert.equal(other.writes(), 0);
  }
  assert.equal((await fixture("superAdminTeacher").create()).status, 200);
});

test("invalid requests and invalid catalog references fail without partial writes", async () => {
  const app = fixture();
  for (const entries of [[], Array(41).fill(input()), [input({ grade: 15 })], [input(), input({ courseId: "missing", courseName: "Missing" })]]) {
    assert.equal((await app.create(entries)).status, 400);
    assert.equal(app.writes(), 0);
  }
  assert.equal((await app.request("POST", null)).status, 400);
});

test("create writes normalized grades, server actor, a snapshot and the shared equivalency lock", async () => {
  const app = fixture();
  assert.equal((await app.create([input({ courseName: "forged title", groupId: "group", groupName: "forged group", createdBy: "forged" })])).status, 200);
  const [record] = await app.list();
  assert.equal(record.courseName, "Derecho");
  assert.equal(record.groupName, "LPI2023");
  assert.equal(record.finalGrade, 85);
  assert.equal(record.grade, 8.5);
  assert.equal(record.createdBy, "admin");
  assert.equal(record.version, 1);
  assert.deepEqual(record.plantelIds, ["campus"]);
  assert.ok(app.records.has("studentEquivalencyLocks/student"));
  const audit = [...app.records].find(([key]) => key.startsWith(`studentAcademicHistory/${record.id}/history/`))[1];
  assert.equal(audit.before, null);
  assert.equal(audit.after.registeredAt, "2026-10-17");
  assert.equal(audit.actorId, "admin");
});

test("duplicates are rejected atomically by subject, normalized group and cycle, but retakes remain possible", async () => {
  const app = fixture();
  assert.equal((await app.create([input(), input({ courseId: null, courseName: "DÉRECHO", groupName: " lpi2023 ", cycle: "2024-2" })])).status, 409);
  assert.equal(app.writes(), 0);
  assert.equal((await app.create()).status, 200);
  const writes = app.writes();
  assert.equal((await app.create()).status, 409);
  assert.equal(app.writes(), writes);
  assert.equal((await app.create([input({ cycle: "2025-1" })])).status, 200);
  assert.equal((await app.create([input({ groupName: "LPI2024" })])).status, 200);
  assert.equal((await app.create([input({ section: "certifications" })])).status, 200);
});

test("existing platform history conflicts in the same group and preserves live records", async () => {
  for (const collection of ["studentEnrollments", "studentEnrollmentsArchive"]) {
    const app = fixture();
    const enrollment = { studentId: "student", groupId: "group", courseClosures: { course: { courseName: "Derecho", finalGrade: 90 } } };
    app.records.set(`${collection}/enrollment`, enrollment);
    assert.equal((await app.create()).status, 409);
    assert.equal(app.writes(), 0);
    assert.equal(app.records.get(`${collection}/enrollment`), enrollment);
    assert.equal((await app.create([input({ groupName: "Otro grupo" })])).status, 200);
  }
});

test("manual captures and equivalencies reject conflicts in both directions", async () => {
  const app = fixture();
  app.records.set("studentEquivalencies/existing", { studentId: "student", status: "active", courseId: "course", courseName: "Derecho" });
  assert.equal((await app.create()).status, 409);
  assert.equal(app.writes(), 0);
  assert.equal((await app.create([input({ section: "certifications" })])).status, 200);
  app.records.delete("studentEquivalencies/existing");
  assert.equal((await app.create()).status, 200);
  const writes = app.writes();
  const mutation = app.equivalents.parseEquivalencyMutation({ entries: [{
    courseId: "course", courseName: "Derecho", grade: 90, gradeScale: 100,
    institution: "Otra escuela", period: "2024", recognizedAt: "2026-10-17", notes: "",
  }] }, true);
  await assert.rejects(app.equivalents.mutateStudentEquivalencies("student", app.access, mutation), (error) => error.status === 409);
  assert.equal(app.writes(), writes);
});

test("corrections require reasons and matching versions while keeping manual date and creation audit", async () => {
  const app = fixture();
  await app.create();
  const [original] = await app.list();
  const body = { action: "update", id: original.id, version: 1, entry: input({ grade: 9, accreditationType: "extraordinary" }), reason: "Corrección contra expediente" };
  assert.equal((await app.request("PATCH", { ...body, reason: " " })).status, 400);
  assert.equal((await app.request("PATCH", { ...body, version: 5 })).status, 409);
  assert.equal((await app.request("PATCH", body)).status, 200);
  const [updated] = await app.list();
  assert.equal(updated.version, 2);
  assert.equal(updated.finalGrade, 90);
  assert.equal(updated.accreditationType, "extraordinary");
  assert.equal(updated.registeredAt, original.registeredAt);
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.createdBy, original.createdBy);
  const audits = [...app.records].filter(([key]) => key.startsWith(`studentAcademicHistory/${original.id}/history/`));
  assert.equal(audits.length, 2);
  assert.equal(audits[1][1].before.finalGrade, 85);
  assert.equal(audits[1][1].after.finalGrade, 90);
  assert.equal((await app.request("PATCH", body)).status, 409);
});

test("linked historical names survive later catalog/group renames and deletions", async () => {
  const app = fixture();
  await app.create([input({ groupId: "group" })]);
  const [record] = await app.list();
  app.records.set("groups/group", { groupName: "Renamed", semester: "9", plantelId: "campus" });
  app.records.delete("courses/course");
  const response = await app.request("PATCH", { action: "update", id: record.id, version: 1, entry: input({ groupId: "group", notes: "Corrección" }), reason: "Agregar referencia" });
  assert.equal(response.status, 200);
  const [updated] = await app.list();
  assert.equal(updated.courseName, "Derecho");
  assert.equal(updated.groupName, "LPI2023");
  assert.equal(updated.semester, "4");
});

test("administrative grades API preserves historical semester, cycle, exam and section despite current group changes", async () => {
  const app = fixture();
  await app.create([input({ groupId: "group", accreditationType: "global" })]);
  app.records.set("groups/group", { groupName: "CERT. Renamed", semester: "9", plantelId: "campus" });
  app.records.set("studentEnrollments/enrollment", {
    studentId: "student", groupId: "group", groupName: "LPI2023",
    courseClosures: { other: { status: "closed", courseName: "Historia", finalGrade: 90 } },
  });
  const response = await app.grades();
  assert.equal(response.status, 200);
  const payload = await response.json();
  const row = payload.data.rows.find((entry) => entry.academicHistoryId);
  assert.equal(row.groupName, "LPI2023");
  assert.equal(row.semester, "4");
  assert.equal(row.section, "academic");
  assert.equal(row.isCertification, false);
  assert.equal(row.cycle, "2024-2");
  assert.equal(row.globalExamGrade, 85);
  assert.equal(row.registeredAt, "2026-10-17");
  assert.equal(app.kardex.countProgramApproved(payload.data.rows), 1);
});

test("student profile loads both manual sections and computes their averages without mixing them", async () => {
  const app = fixture();
  await app.create([
    input({ grade: 6, cycle: "2023-2" }),
    input({ grade: 9, cycle: "2024-2", accreditationType: "extraordinary" }),
    input({ grade: 10, section: "certifications", courseId: null, courseName: "Inglés", groupName: "Grupo histórico" }),
  ]);
  app.records.set("courses/course", { title: "Renamed catalog course" });
  const student = app.studentKardex();
  const rows = await student.loadKardex("student", { course: "Renamed catalog course" });
  assert.equal(rows.length, 3);
  const academic = app.kardex.filterKardexRows(rows, "academic");
  const certifications = app.kardex.filterKardexRows(rows, "certifications");
  assert.equal(academic.length, 2);
  assert.equal(certifications.length, 1);
  assert.equal(student.kardexAverage(academic), 75);
  assert.equal(student.kardexAverage(certifications), 100);
  assert.ok(academic.every((row) => row.courseName === "Derecho" && row.closedAt instanceof Date));
  assert.equal(academic.find((row) => row.accreditationType === "extraordinary").extraordinaryExamGrade, 90);
  assert.equal(app.kardex.countProgramApproved(academic), 1);
  const failing = academic.find((row) => row.finalGrade === 60);
  await app.request("PATCH", { action: "cancel", id: failing.academicHistoryId, version: 1, reason: "Anular registro de prueba" });
  const updated = await student.loadKardex("student", {});
  assert.equal(updated.length, 2);
  assert.equal(student.kardexAverage(app.kardex.filterKardexRows(updated, "academic")), 90);
});

test("cancellation preserves the full audit and removes the row from student kardex reads", async () => {
  const app = fixture();
  await app.create();
  const [record] = await app.list();
  const body = { action: "cancel", id: record.id, version: 1, reason: "Registro duplicado en expediente" };
  assert.equal((await app.request("PATCH", { ...body, reason: "" })).status, 400);
  assert.equal((await app.request("PATCH", body)).status, 200);
  assert.equal((await app.list()).length, 0);
  const [cancelled] = await app.list(true);
  assert.equal(cancelled.status, "cancelled");
  const self = { uid: "student", role: "student", plantelIds: [] };
  assert.equal((await app.server.readStudentAcademicHistory("student", self)).length, 0);
  await assert.rejects(app.server.readStudentAcademicHistory("student", self, true), (error) => error.status === 403);
  assert.equal((await app.request("PATCH", body)).status, 409);
  assert.equal((await app.create()).status, 200);
});

test("read scope includes self and matching current/historical campuses and excludes other campuses and teachers", async () => {
  const app = fixture();
  await app.create();
  const [record] = await app.list();
  const read = (access) => app.server.readStudentAcademicHistory("student", access);
  assert.equal((await read({ uid: "student", role: "student", plantelIds: [] })).length, 1);
  assert.equal((await read({ uid: "coordinator", role: "coordinadorPlantel", plantelIds: ["campus"] })).length, 1);
  assert.equal((await read({ uid: "director", role: "director", plantelIds: ["old-campus"] })).length, 0);
  app.records.set(`studentAcademicHistory/${record.id}`, { ...record, plantelIds: ["old-campus"] });
  assert.equal((await read({ uid: "director", role: "director", plantelIds: ["old-campus"] })).length, 1);
  await assert.rejects(read({ uid: "outsider", role: "director", plantelIds: ["other-campus"] }), (error) => error.status === 403);
  await assert.rejects(read({ uid: "teacher", role: "teacher", plantelIds: ["campus"] }), (error) => error.status === 403);
});
