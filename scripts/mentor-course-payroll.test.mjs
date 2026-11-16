import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(fs.readFileSync(
  new URL("../src/lib/firebase/groups-service.ts", import.meta.url), "utf8",
), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function fixture() {
  const amounts = { mentor: { "course.a": 1000, "course.b": 2000 } };
  const deleted = Symbol("deleted");
  let writes = 0;
  class FieldPath {
    constructor(...segments) { this.segments = segments; }
  }
  const dependencies = {
    "firebase/firestore": {
      FieldPath,
      doc: () => ({}),
      getDoc: async () => ({
        exists: () => true,
        data: () => ({
          assistantTeacherIds: ["mentor"],
          courses: [{ courseId: "course.a" }, { courseId: "course.b" }],
          mentorCoursePayrollAmounts: structuredClone(amounts),
        }),
      }),
      deleteField: () => deleted,
      serverTimestamp: () => "server-time",
      updateDoc: async (_ref, field, value, timestampField, timestamp) => {
        assert.ok(field instanceof FieldPath, "Save only the edited course amount");
        const [root, mentorId, courseId] = field.segments;
        assert.equal(root, "mentorCoursePayrollAmounts");
        assert.equal(timestampField, "updatedAt");
        assert.equal(timestamp, "server-time");
        if (value === deleted) delete amounts[mentorId][courseId];
        else amounts[mentorId][courseId] = value;
        writes++;
      },
    },
    "@/lib/firebase/client": { auth: {} },
    "@/lib/firebase/firestore": { db: {} },
    "@/lib/students/status": {},
  };
  const serviceModule = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: serviceModule.exports, module: serviceModule,
    require: (name) => {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    amounts, writes: () => writes,
    save: (courseId, amount, mentorId = "mentor") => serviceModule.exports.setMentorCoursePayrollAmount({
      groupId: "group", mentorId, courseId, amount,
    }),
  };
}

test("simultaneous saves preserve both amounts, including course IDs with dots", async () => {
  const app = fixture();
  await Promise.all([app.save("course.a", 1600), app.save("course.b", 2500.556)]);
  assert.deepEqual(app.amounts, { mentor: { "course.a": 1600, "course.b": 2500.56 } });
  assert.equal(app.writes(), 2);
});

test("clearing one amount preserves the other and an explicit zero is saved", async () => {
  const app = fixture();
  await app.save("course.a", null);
  assert.deepEqual(app.amounts, { mentor: { "course.b": 2000 } });
  await app.save("course.a", 0);
  assert.equal(app.amounts.mentor["course.a"], 0);
});

test("unassigned mentors or courses cannot save amounts", async () => {
  const app = fixture();
  await assert.rejects(app.save("unassigned", 1600), /materia no está asignada/);
  await assert.rejects(app.save("course.a", 1600, "other"), /mentor no está asignado/);
  assert.equal(app.writes(), 0);
});
