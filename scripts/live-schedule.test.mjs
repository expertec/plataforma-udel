import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const modules = new Map();
function load(name) {
  if (name === "firebase-admin/firestore") return { FieldValue: { increment: (value) => ({ increment: value }) } };
  if (modules.has(name)) return modules.get(name);
  const source = fs.readFileSync(new URL(`${name.replace("@/", "src/")}.ts`, root), "utf8");
  const context = { exports: {}, require: load };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  modules.set(name, context.exports);
  return context.exports;
}
const { writeWithLiveScheduleCheck } = load("@/lib/server/live-schedule");
const session = (start = "10:00", end = "11:00", status = "scheduled") => ({
  scheduledStartAt: `2026-11-10T${start}:00Z`, scheduledEndAt: end ? `2026-11-10T${end}:00Z` : null,
  status, timezone: "America/Monterrey",
});
const oldClass = "courses/other/lessons/week/classes/existing";
const newClass = "courses/shared/lessons/week/classes/new";

function fixture({ program = "Licenciatura", existing = session(), shared = true } = {}) {
  const records = new Map([
    ["groups/a", { groupName: "Grupo A", program, status: "active", courses: [{ courseId: "shared" }] }],
    ["groups/b", { groupName: "Grupo B", program, status: "active", courseIds: shared ? ["shared", "other"] : ["other"] }],
    ["courses/shared/lessons/week", {}], ["courses/other/lessons/week", {}],
    [oldClass, { title: "Otra materia con otro profesor", type: "live", liveSession: existing }],
  ]);
  const writes = [];
  function collection(path, filters = []) {
    return {
      doc: (id) => document(`${path}/${id}`),
      where: (field, operator, value) => { assert.equal(operator, "=="); return collection(path, [...filters, [field, value]]); },
      docs: () => [...records.entries()].filter(([key, data]) => key.startsWith(`${path}/`) &&
        key.split("/").length === path.split("/").length + 1 && filters.every(([field, value]) => data[field] === value))
        .map(([key, data]) => ({ id: key.split("/").at(-1), ref: document(key), data: () => data })),
    };
  }
  function document(path) { return { path, collection: (name) => collection(`${path}/${name}`) }; }
  const db = {
    collection,
    runTransaction: async (callback) => {
      const pending = [];
      let writing = false;
      await callback({
        get: async (query) => { assert.equal(writing, false, "All reads must precede writes"); return { docs: query.docs() }; },
        update: (ref, data) => { writing = true; pending.push({ path: ref.path, data }); },
        set: (ref, data) => { writing = true; pending.push({ path: ref.path, data }); },
      });
      writes.push(...pending);
      for (const { path, data } of pending) records.set(path, { ...records.get(path), ...data });
    },
  };
  return {
    records, writes,
    save: (input = session(), path = newClass) => writeWithLiveScheduleCheck({
      db, courseId: "shared", classPath: path, liveSession: input,
      write: (transaction) => transaction.set(document(path), { type: "live", liveSession: input }),
    }),
  };
}

test("rejects a different course/teacher conflicting with a group that shares the new class", async () => {
  const f = fixture();
  await assert.rejects(f.save(), (error) => error.status === 409 && /Grupo B/.test(error.message) && /Otra materia/.test(error.message));
  assert.equal(f.writes.length, 0);
});
test("detects partial overlap and either interval containing the other", async () => {
  for (const [start, end] of [["09:30", "10:30"], ["10:30", "11:30"], ["09:00", "12:00"], ["10:15", "10:45"]]) {
    await assert.rejects(fixture().save(session(start, end)), (error) => error.status === 409);
  }
});
test("allows consecutive classes at the exact boundary, and reserves both shared groups atomically", async () => {
  const f = fixture();
  await f.save(session("11:00", "12:00"));
  assert.equal(f.writes.length, 3);
  assert.ok(f.writes.some((write) => write.path === "groups/a"));
  assert.ok(f.writes.some((write) => write.path === "groups/b"));
});
test("allows classes ending exactly when the existing class starts", async () => {
  await fixture().save(session("09:00", "10:00"));
});
test("does not compare unrelated groups", async () => { await fixture({ shared: false }).save(); });
test("only undergraduate programs are subject to conflict checks", async () => {
  for (const program of ["Preparatoria", "Maestría", "Certificación"]) await fixture({ program }).save(session("10:00", null));
});
test("requires a valid closing time for undergraduate schedules", async () => {
  for (const input of [session("10:00", null), session("10:00", "10:00"), session("11:00", "10:00")]) {
    await assert.rejects(fixture().save(input), (error) => error.status === 400);
  }
});
test("finished sessions do not block scheduling", async () => {
  for (const status of ["ended", "recording_ready"]) await fixture({ existing: session("10:00", "11:00", status) }).save();
});
test("editing the same class excludes itself", async () => {
  const f = fixture();
  f.records.delete(oldClass);
  f.records.set(newClass, { type: "live", liveSession: session() });
  await f.save();
});
test("rescheduling another class into a reserved interval is rejected", async () => {
  await assert.rejects(fixture().save(session(), "courses/shared/lessons/week/classes/edited"), (error) => error.status === 409);
});
test("legacy sessions without a closing time require correction instead of assuming availability", async () => {
  await assert.rejects(fixture({ existing: session("09:00", null) }).save(), (error) => error.status === 409 && /sin cierre programado/.test(error.message));
});
test("archived groups do not reserve an interval", async () => {
  const f = fixture();
  f.records.get("groups/b").status = "archived";
  await f.save();
});
