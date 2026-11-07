import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = new Map();
function load(name, parent = root) {
  const filename = name.startsWith("@/") ? path.join(root, "src", `${name.slice(2)}.ts`)
    : path.resolve(path.dirname(parent), `${name}.ts`);
  if (modules.has(filename)) return modules.get(filename).exports;
  const loadedModule = { exports: {} };
  modules.set(filename, loadedModule);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, Date, Intl,
    require: dependency => load(dependency, filename) }, { filename });
  return loadedModule.exports;
}
const { getAcademicAlert, academicAlertEvidence } = load("@/lib/students/academic-alert");
const now = Date.parse("2026-11-07T12:00:00Z");
const closure = (changes = {}) => ({ status: "closed", finalGrade: 30, courseName: "Derecho",
  groupId: "group", pendingUngradedCount: 0, totalEvaluable: 5, ...changes });
const exam = (changes = {}) => ({ courseId: "course", groupId: "group", courseName: "Derecho",
  reason: "failed_course", passed: false, enabled: true, status: "enabled", examKind: "extraordinary",
  attemptsUsed: 0, attemptsAllowed: 1, expiresAt: "2026-11-10T12:00:00Z", ...changes });
const alert = (c = {}, exams = [], titles = {}) => getAcademicAlert(c, titles, exams, now);
const silent = result => { assert.equal(result.notice, ""); assert.equal(result.hasActiveExam, false); };

test("empty records, current courses and assignments alone do not announce failure", () => {
  silent(alert());
  silent(alert({}, [exam()]));
  silent(alert({ "enrollment::course": closure({ status: "open", finalGrade: 0 }) }, [exam()]));
});

test("certifications are excluded by group, program, explicit flag or title", () => {
  for (const fields of [{ groupName: " CERT.GEMINI " }, { program: "Certificaciones complementarias" },
    { isCertification: true }, { courseName: "Certificación Gemini al Límite" }]) {
    silent(alert({ "enrollment::course": closure(fields) }, [exam()]));
  }
  silent(alert({ "enrollment::course": closure({ courseName: "" }) }, [exam()], { course: "Certificación Gemini" }));
  silent(alert({ "enrollment::course": closure({ courseName: "Materia" }) }, [exam()], { course: "Certificación Gemini" }));
});

test("partial and ambiguous legacy closures do not become confirmed failures", () => {
  silent(alert({ "enrollment::course": closure({ finalGrade: 0, pendingUngradedCount: 8 }) }, [exam()]));
  silent(alert({ "enrollment::course": { status: "closed", finalGrade: 0 } }, [exam()]));
  silent(alert({ "enrollment::course": closure({ totalEvaluable: 0 }) }, [exam()]));
});

test("explicit final grades survive missing activities, including a captured zero", () => {
  for (const evidence of [{ manualOverride: true }, { campusFinalExamGrade: 0 },
    { gradeSource: "globalRegularizationExam" }, { gradeSource: "extraordinaryRegularizationExam" }]) {
    const result = alert({ "enrollment::course": closure({ pendingUngradedCount: 8, ...evidence }) }, [exam()]);
    assert.match(result.notice, /1 materia no acreditada: Derecho/);
    assert.equal(result.hasActiveExam, true);
  }
});

test("a confirmed failure needs no final exam configuration to show the notice", () => {
  const result = alert({ "enrollment::course": closure() });
  assert.match(result.notice, /Derecho.*Acércate a tu coordinador/);
  assert.equal(result.hasActiveExam, false);
});

test("extraordinary range retains its existing assignment requirement", () => {
  const c = { "enrollment::course": closure({ finalGrade: 60 }) };
  silent(alert(c));
  assert.match(alert(c, [exam()]).notice, /Derecho/);
  silent(alert(c, [exam({ groupId: "other-group" })]));
  silent(alert(c, [exam({ status: "disabled" })]));
  silent(alert(c, [exam({ reason: "late_joiner" })]));
});

test("an approved closure or passed exam clears old failures", () => {
  silent(alert({ "old::course": closure(), "new::course": closure({ finalGrade: 70 }) }, [exam()]));
  silent(alert({ "old::course": closure() }, [exam({ passed: true, status: "passed" })]));
});

test("repeated closures count once and invalid grades never trigger the notice", () => {
  assert.match(alert({ "one::course": closure(), "two::course": closure() }).notice, /1 materia no acreditada/);
  for (const finalGrade of [undefined, NaN, Infinity, -1, 101]) {
    silent(alert({ "enrollment::course": closure({ finalGrade }) }, [exam()]));
  }
});

test("exam links reflect group, validity and remaining attempts", () => {
  const c = { "enrollment::course": closure() };
  assert.equal(alert(c, [exam()]).hasActiveExam, true);
  for (const changes of [{ groupId: "other-group" }, { expiresAt: "2026-11-01T12:00:00Z" },
    { attemptsUsed: 1 }, { enabled: false }, { reason: "late_joiner" }, { groupName: "CERT.IA" }]) {
    assert.equal(alert(c, [exam(changes)]).hasActiveExam, false);
  }
});

test("Firestore adapter retains the evidence and prefers the actual group", () => {
  const evidence = academicAlertEvidence({ manualOverride: true, campusFinalExamGrade: 0,
    pendingUngradedCount: 7, totalEvaluable: 8, gradeSource: "globalRegularizationExam" },
  { groupId: "group", groupName: "old" }, { groupName: "CERT.IA", program: "Certificaciones" });
  assert.equal(evidence.groupName, "CERT.IA");
  assert.equal(evidence.pendingUngradedCount, 7);
  assert.equal(evidence.campusFinalExamGrade, 0);
  silent(alert({ "enrollment::course": closure(evidence) }, [exam()]));
});
