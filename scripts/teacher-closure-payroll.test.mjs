import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import admin from "firebase-admin";

const { firestore } = admin;

const source = fs.readFileSync(
  new URL("../src/app/api/admin/teacher-closure-payroll/route.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceKey = "group:course";
const paymentId = Buffer.from(sourceKey).toString("base64url");
const paymentPath = `teacherPayrollItems/${paymentId}`;
const originalPaidAt = firestore.Timestamp.fromDate(new Date("2026-10-15T16:00:00Z"));
const dateFormatModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(
  new URL("../src/lib/utils/date-format.ts", import.meta.url), "utf8",
), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: dateFormatModule.exports, module: dateFormatModule });

// An isolated Firestore double lets the real route handlers run without touching live payroll.
function fixture(role = "adminTeacher", payment = {}) {
  const actor = { uid: "admin-id", role, displayName: "Administradora", email: "admin@example.test" };
  const records = new Map([
    ["users/admin-id", { role, plantelIds: ["campus"] }],
    ["users/teacher", { name: "Docente", payrollDeposit: { bank: "Banco", clabe: "123" } }],
    ["groups/group", {
      groupName: "Grupo", teacherId: "teacher", plantelId: "campus",
      courses: [{ courseId: "course", courseName: "Materia", program: "Licenciatura" }],
    }],
    ["groups/group/students/student", { status: "active" }],
    ["studentEnrollments/group_student", {
      groupId: "group", studentId: "student", status: "active",
      courseClosures: { course: { status: "closed", closedAt: originalPaidAt, closedById: "teacher" } },
    }],
    ["courses/course", { title: "Materia", program: "Licenciatura" }],
    [paymentPath, {
      sourceKey, status: "paid", amount: 1900,
      paidAt: originalPaidAt, paidById: "original-id", paidByName: "Usuario original",
      paidByEmail: "original@example.test", ...payment,
    }],
  ]);
  let writes = 0;
  function snapshot(documentPath) {
    const data = records.get(documentPath);
    return {
      id: documentPath.split("/").at(-1), exists: Boolean(data), ref: document(documentPath),
      data: () => data, get: (field) => data?.[field],
    };
  }
  function document(documentPath) {
    return {
      path: documentPath, get: async () => snapshot(documentPath),
      collection: (name) => collection(`${documentPath}/${name}`),
    };
  }
  function collection(collectionPath, filters = []) {
    return {
      doc: (id) => document(`${collectionPath}/${id}`),
      where: (field, operator, value) => {
        assert.equal(operator, "==");
        return collection(collectionPath, [...filters, [field, value]]);
      },
      get: async () => {
        const docs = [...records.keys()].filter((key) =>
          key.startsWith(`${collectionPath}/`) &&
          key.split("/").length === collectionPath.split("/").length + 1 &&
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
        get: (ref) => ref.get(),
        set: (ref, data) => pending.push([ref.path, data]),
        update: (ref, data) => pending.push([ref.path, data]),
      });
      for (const [key, data] of pending) {
        records.set(key, { ...records.get(key), ...data });
        writes += 1;
      }
    },
  };
  class TeacherAccessError extends Error {}
  const dependencies = {
    "@/lib/utils/date-format": dateFormatModule.exports,
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "firebase-admin": { firestore },
    "@/lib/firebase/admin": { getAdminFirestore: () => db },
    "@/lib/server/require-teacher-access": {
      TeacherAccessError, requireTeacherAccess: async () => actor,
    },
    "@/lib/students/status": { isStudentStatusActive: (status) => !status || status === "active" },
    "@/lib/teachers/profile": {
      normalizeTeacherPayrollDeposit: (value) => ({
        bank: "", debitCard: "", clabe: "", depositDetails: "", ...value,
      }),
    },
  };
  const routeModule = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: routeModule.exports, module: routeModule, Buffer, console,
    require: (name) => {
      assert.ok(dependencies[name], `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  });
  const request = (body) => ({ json: async () => body });
  return {
    records, actor, writes: () => writes,
    patch: (body = { sourceKey, confirmed: true }) => routeModule.exports.PATCH(request(body)),
    post: (body = { sourceKey, amount: 1900, payeeId: "teacher", payeeName: "Docente" }) =>
      routeModule.exports.POST(request(body)),
    get: (from = "2026-10-01", to = "2026-10-31") => routeModule.exports.GET({
      nextUrl: new URL(`https://example.test?from=${from}&to=${to}`),
    }),
    malformed: () => routeModule.exports.PATCH({ json: async () => { throw new SyntaxError(); } }),
  };
}

test("payroll includes the entire selected day in Monterrey and excludes adjacent days", async () => {
  const app = fixture();
  for (const [instant, expectedCount] of [
    ["2026-11-14T05:59:59.999Z", 0], // Previous day, 23:59:59.999.
    ["2026-11-14T06:00:00.000Z", 1], // Selected day, midnight.
    ["2026-11-15T02:00:00.000Z", 1], // Selected day, 20:00.
    ["2026-11-15T05:59:59.999Z", 1], // Selected day, final millisecond.
    ["2026-11-15T06:00:00.000Z", 0], // Following day, midnight.
  ]) {
    app.records.get("studentEnrollments/group_student").courseClosures.course.closedAt =
      firestore.Timestamp.fromDate(new Date(instant));
    const response = await app.get("2026-11-14", "2026-11-14");
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.items.length, expectedCount, instant);
    assert.equal(data.from, "2026-11-14T06:00:00.000Z");
    assert.equal(data.to, "2026-11-15T05:59:59.999Z");
  }
});

test("invalid calendar dates and reversed ranges are rejected", async () => {
  const app = fixture();
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-11-01", "2026-11-31"],
    ["2026-11-15", "2026-11-14"],
  ]) {
    assert.equal((await app.get(from, to)).status, 400);
  }
});

function mentorFixture() {
  const app = fixture();
  const group = app.records.get("groups/group");
  group.assistantTeachers = [{ id: "mentor", name: "Mentor" }];
  group.mentorCourseAccess = { mentor: ["course"] };
  app.records.set("users/mentor", { name: "Mentor", payrollDeposit: { bank: "Banco" } });
  app.records.delete(paymentPath);
  return app;
}

test("mentors without an amount require review even when all students are closed", async () => {
  const app = mentorFixture();
  const { data } = await (await app.get()).json();
  assert.equal(data.items[0].status, "review");
  assert.equal(data.items[0].configuredPayrollAmount, null);
  assert.match(data.items[0].reasons.join(" "), /Falta configurar el monto/);
  assert.equal(data.summary.payable, 0);
  assert.equal(data.summary.review, 1);
});

test("missing mentor amounts require review even when students are still open", async () => {
  const app = mentorFixture();
  app.records.set("groups/group/students/open", { status: "active" });
  app.records.set("studentEnrollments/group_open", {
    groupId: "group", studentId: "open", status: "active",
  });
  const { data } = await (await app.get()).json();
  assert.equal(data.items[0].openCount, 1);
  assert.equal(data.items[0].status, "review");
});

test("only a configured valid amount restores mentor payable status, including explicit zero", async () => {
  const app = mentorFixture();
  for (const amount of [null, "", "  ", false, -1, "invalid"]) {
    app.records.get("groups/group").mentorCoursePayrollAmounts = { mentor: { course: amount } };
    const { data } = await (await app.get()).json();
    assert.equal(data.items[0].status, "review", String(amount));
  }
  for (const amount of [1600, 0]) {
    app.records.get("groups/group").mentorCoursePayrollAmounts = { mentor: { course: amount } };
    const { data } = await (await app.get()).json();
    assert.equal(data.items[0].status, "payable");
    assert.equal(data.items[0].configuredPayrollAmount, amount);
  }
});

test("missing amounts do not change already paid records", async () => {
  const app = mentorFixture();
  app.records.set(paymentPath, { sourceKey, status: "paid", paidAt: originalPaidAt });
  const { data } = await (await app.get()).json();
  assert.equal(data.items[0].status, "paid");
  assert.equal(data.summary.payable, 0);
});

test("payment requests cannot bypass missing mentor amounts with a fallback or stale report", async () => {
  const app = mentorFixture();
  assert.equal((await app.post()).status, 409);
  assert.equal(app.writes(), 0);
  app.records.get("groups/group").mentorCoursePayrollAmounts = { mentor: { course: 1600 } };
  const { data } = await (await app.get()).json();
  assert.equal(data.items[0].status, "payable");
  delete app.records.get("groups/group").mentorCoursePayrollAmounts;
  assert.equal((await app.post({ sourceKey, payeeId: "mentor", amount: 1600 })).status, 409);
  assert.equal(app.writes(), 0);
  app.records.get("groups/group").mentorCoursePayrollAmounts = { mentor: { course: 1600 } };
  assert.equal((await app.post({ sourceKey, payeeId: "mentor", amount: 1600 })).status, 200);
  assert.equal(app.writes(), 1);
});

test("only the exact adminTeacher role can unmark a payment", async () => {
  for (const role of ["teacher", "coordinadorPlantel", "director", "superAdminTeacher"]) {
    const app = fixture(role);
    assert.equal((await app.patch()).status, 403, role);
    assert.equal(app.writes(), 0);
    assert.equal(app.records.get(paymentPath).status, "paid");
  }
});

test("confirmation and valid input are required before any write", async () => {
  const app = fixture();
  for (const body of [null, [], {}, { sourceKey }, { sourceKey, confirmed: "true" },
    { sourceKey: "invalid", confirmed: true }]) {
    assert.equal((await app.patch(body)).status, 400);
  }
  assert.equal((await app.malformed()).status, 400);
  assert.equal(app.writes(), 0);
});

test("unmark records the authenticated actor and server time while preserving the original payment", async () => {
  const app = fixture();
  const before = Date.now();
  const response = await app.patch({
    sourceKey, confirmed: true, unpaidById: "forged", unpaidAt: "2000-01-01",
  });
  assert.equal(response.status, 200);
  const payment = app.records.get(paymentPath);
  assert.equal(payment.status, "unpaid");
  assert.equal(payment.amount, 1900);
  assert.equal(payment.paidById, "original-id");
  assert.equal(payment.paidAt.toMillis(), originalPaidAt.toMillis());
  assert.equal(payment.unpaidById, app.actor.uid);
  assert.equal(payment.unpaidByName, app.actor.displayName);
  assert.equal(payment.unpaidByEmail, app.actor.email);
  assert.equal(payment.paymentHistory[0].action, "paid");
  assert.equal(payment.paymentHistory[0].byId, "original-id");
  const reversal = payment.paymentHistory[1];
  assert.equal(reversal.action, "unpaid");
  assert.equal(reversal.byId, app.actor.uid);
  assert.ok(reversal.at.toMillis() >= before && reversal.at.toMillis() <= Date.now());
  assert.ok(payment.unpaidAt instanceof firestore.FieldValue);
});

test("repeated reversals and nonexistent payments return conflict without modifying history", async () => {
  const app = fixture();
  assert.equal((await app.patch()).status, 200);
  assert.equal((await app.patch()).status, 409);
  assert.equal(app.writes(), 1);
  assert.equal(app.records.get(paymentPath).paymentHistory.length, 2);
  assert.equal((await app.patch({ sourceKey: "other:course", confirmed: true })).status, 409);
  assert.equal(app.writes(), 1);
});

test("legacy approved records are also reversed, including duplicate records for the same source", async () => {
  const app = fixture();
  app.records.set("teacherPayrollItems/legacy", { ...app.records.get(paymentPath), status: "approved" });
  assert.equal((await app.patch()).status, 200);
  assert.equal(app.records.get("teacherPayrollItems/legacy").status, "unpaid");
  assert.equal(app.records.get(paymentPath).status, "unpaid");
  assert.equal(app.writes(), 2);
});

test("listing restores payable status and exposes the full audit history after unmarking", async () => {
  const app = fixture();
  let response = await app.get();
  assert.equal(response.status, 200);
  let data = (await response.json()).data;
  assert.equal(data.canUnmarkPaid, true);
  assert.equal(data.items[0].status, "paid");
  assert.equal(data.items[0].paymentHistory[0].byName, "Usuario original");
  await app.patch();
  response = await app.get();
  data = (await response.json()).data;
  assert.equal(data.items[0].status, "payable");
  assert.deepEqual(data.items[0].paymentHistory.map((entry) => entry.action), ["paid", "unpaid"]);
  assert.equal(data.summary.paid, 0);
  assert.equal(data.summary.payable, 1);
  assert.equal((await (await fixture("director").get()).json()).data.canUnmarkPaid, false);
});

test("paying again appends to history and duplicate payment requests do not overwrite the actor", async () => {
  const app = fixture();
  assert.equal((await app.post()).status, 409);
  assert.equal(app.writes(), 0);
  await app.patch();
  assert.equal((await app.post()).status, 200);
  const data = (await (await app.get()).json()).data;
  assert.equal(data.items[0].status, "paid");
  assert.deepEqual(data.items[0].paymentHistory.map((entry) => entry.action), ["paid", "unpaid", "paid"]);
  assert.equal(app.records.get(paymentPath).paidById, app.actor.uid);
  const writes = app.writes();
  assert.equal((await app.post()).status, 409);
  assert.equal(app.writes(), writes);
  assert.equal(app.records.get(paymentPath).paymentHistory.length, 3);
});
