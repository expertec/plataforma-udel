import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function fixture(user, { conflict = false } = {}) {
  const records = new Map([
    ["users/user", user],
    ["courses/course", { teacherId: "other-teacher" }],
    ["groups/group", { plantelId: "campus", program: "Licenciatura", courseIds: ["course"] }],
    ["courses/course/lessons/week", {}],
  ]);
  const liveSession = {
    status: "scheduled", timezone: "America/Monterrey",
    scheduledStartAt: "2026-11-18T00:00:00.000Z",
    scheduledEndAt: "2026-11-18T01:00:00.000Z",
  };
  if (conflict) records.set("courses/course/lessons/week/classes/existing", {
    title: "Teoría Económica", type: "live", liveSession,
  });
  const writes = [];
  function document(path) {
    return {
      path, id: path.split("/").at(-1),
      collection: (name) => collection(`${path}/${name}`),
      get: async () => ({ exists: records.has(path), data: () => records.get(path) }),
    };
  }
  function collection(path, filters = []) {
    return {
      doc: (id = "new") => document(`${path}/${id}`),
      where: (field, op, value) => collection(path, [...filters, [field, op, value]]),
      get: async () => ({ docs: [...records].filter(([key, data]) =>
        key.startsWith(`${path}/`) && key.split("/").length === path.split("/").length + 1 &&
        filters.every(([field, op, value]) => op === "array-contains"
          ? Array.isArray(data[field]) && data[field].includes(value)
          : data[field] === value),
      ).map(([key, data]) => ({ ...document(key), ref: document(key), data: () => data })) }),
    };
  }
  const db = {
    collection, doc: document,
    runTransaction: async (callback) => {
      const pending = [];
      await callback({
        get: (query) => query.get(),
        set: (ref, data) => pending.push({ path: ref.path, data }),
        update: (ref, data) => pending.push({ path: ref.path, data }),
      });
      writes.push(...pending);
    },
  };
  const modules = new Map();
  function load(name) {
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options.status }) } };
    if (name === "firebase-admin/firestore") return { FieldValue: { serverTimestamp: () => "now", increment: (n) => n } };
    if (name === "@/lib/firebase/admin") return {
      getAdminFirestore: () => db,
      getAdminAuth: () => ({ verifyIdToken: async () => ({ uid: "user" }) }),
    };
    if (modules.has(name)) return modules.get(name);
    const source = fs.readFileSync(new URL(`${name.replace("@/", "src/")}.ts`, root), "utf8");
    const context = { exports: {}, require: load, console };
    vm.runInNewContext(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText, context);
    modules.set(name, context.exports);
    return context.exports;
  }
  const { POST } = load("@/app/api/courses/[courseId]/lessons/[lessonId]/classes/route");
  return {
    writes,
    save: (overrides = {}) => POST({
      headers: new Headers({ authorization: "Bearer token" }),
      json: async () => ({ title: "Nueva clase", type: "live", order: 0, liveSession, ...overrides }),
    }, { params: Promise.resolve({ courseId: "course", lessonId: "week" }) }),
    edit: async (body, existingSession = liveSession) => {
      records.set("courses/course/lessons/week/classes/edited", { type: "live", liveSession: existingSession });
      const { PATCH } = load("@/app/api/courses/[courseId]/lessons/[lessonId]/classes/[classId]/route");
      return PATCH({
        headers: new Headers({ authorization: "Bearer token" }),
        json: async () => body,
      }, { params: Promise.resolve({ courseId: "course", lessonId: "week", classId: "edited" }) });
    },
  };
}

test("coordinators and directors can create live classes in their assigned campus", async () => {
  for (const role of ["coordinadorPlantel", "director"]) {
    for (const campus of [{ plantelIds: ["campus"] }, { plantelId: "campus" }]) {
      const f = fixture({ role, ...campus });
      const result = await f.save();
      assert.equal(result.status, 201);
      assert.ok(f.writes.some(({ path, data }) => path.endsWith("classes/new") && data.type === "live"));
    }
  }
});

test("campus permissions do not grant access to another campus or an unassigned teacher", async () => {
  for (const user of [
    { role: "coordinadorPlantel", plantelIds: ["different-campus"] },
    { role: "director" },
    { role: "teacher", plantelIds: ["campus"] },
  ]) {
    const f = fixture(user);
    assert.equal((await f.save()).status, 403);
    assert.equal(f.writes.length, 0);
  }
});

test("a conflicting live class returns its explanation and writes nothing", async () => {
  const f = fixture({ role: "coordinadorPlantel", plantelIds: ["campus"] }, { conflict: true });
  const result = await f.save();
  assert.equal(result.status, 409);
  assert.match(result.body.error, /Teoría Económica/);
  assert.match(result.body.error, /Elige otro horario/);
  assert.equal(f.writes.length, 0);
});

test("creating a live class cannot omit or supply an invalid closing time", async () => {
  for (const liveSession of [null, { scheduledStartAt: "2026-11-18T00:00:00Z" }, {
    scheduledStartAt: "2026-11-18T00:00:00Z", scheduledEndAt: "2026-11-17T23:00:00Z",
  }]) {
    const f = fixture({ role: "superAdminTeacher" });
    assert.equal((await f.save({ liveSession })).status, 400);
    assert.equal(f.writes.length, 0);
  }
});

test("editing a legacy class requires a valid closing time even for a title-only change", async () => {
  const legacy = { scheduledStartAt: "2026-11-17T22:00:00Z", scheduledEndAt: null };
  const f = fixture({ role: "superAdminTeacher" });
  assert.equal((await f.edit({ title: "Nuevo título" }, legacy)).status, 400);
  assert.equal(f.writes.length, 0);
  const result = await f.edit({ liveSession: { ...legacy, scheduledEndAt: "2026-11-17T23:00:00Z" } }, legacy);
  assert.equal(result.status, 200);
});
