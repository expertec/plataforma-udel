import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const loadedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../src/lib/students/manual-grade-scale.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: loadedModule.exports, module: loadedModule });
const { confirmManualGradeScale, getManualGradeScaleWarning } = loadedModule.exports;
const entry = (changes = {}) => ({ studentName: "Alumna", finalGrade: 10, autoGrade: 97, manualOverride: true, ...changes });

test("a 10 final over an automatic 97 requires explicit confirmation and can be cancelled", async () => {
  let calls = 0;
  const accepted = await confirmManualGradeScale([entry()], async context => {
    calls++;
    assert.match(context.message, /final manual 10\/100, cálculo automático 97\/100/);
    assert.match(context.message, /10 sobre 10, captura 100/);
    assert.equal(context.confirmLabel, "Confirmar 10/100");
    assert.equal(context.cancelLabel, "Revisar captura");
    return false;
  });
  assert.equal(calls, 1);
  assert.equal(accepted, false);
});

test("a genuine low manual grade can be confirmed without converting or changing it", async () => {
  const grade = entry({ finalGrade: 8 });
  assert.equal(await confirmManualGradeScale([grade], async () => true), true);
  assert.equal(grade.finalGrade, 8);
  assert.equal(grade.autoGrade, 97);
});

test("a likely ten-point grade also warns when no automatic grade is available", async () => {
  assert.match(getManualGradeScaleWarning(entry({ finalGrade: 9.5, autoGrade: null })), /9.5\/10, captura 95\/100/);
  let calls = 0;
  assert.equal(await confirmManualGradeScale([entry({ autoGrade: null })], async () => { calls++; return false; }), false);
  assert.equal(calls, 1);
});

test("passing grades, automatic low grades and unchanged ordinary zeros do not prompt", async () => {
  const ask = async () => { assert.fail("No scale confirmation should be requested"); };
  for (const changes of [{ finalGrade: 70 }, { finalGrade: 90 }, { finalGrade: 100 },
    { finalGrade: 30 }, { manualOverride: false }, { finalGrade: 0, autoGrade: 0 }, { finalGrade: 0, autoGrade: null }]) {
    const grade = entry(changes);
    assert.equal(getManualGradeScaleWarning(grade), null);
    assert.equal(await confirmManualGradeScale([grade], ask), true);
  }
});

test("a manual zero against a passing automatic calculation requires review", async () => {
  assert.match(getManualGradeScaleWarning(entry({ finalGrade: 0 })), /cálculo automático es aprobatorio/);
  assert.equal(await confirmManualGradeScale([entry({ finalGrade: 0 })], async () => false), false);
});

test("bulk confirmation lists every suspicious student and excludes ordinary grades", async () => {
  const suspicious = Array.from({ length: 9 }, (_, i) => entry({ studentName: `Alumno ${i + 1}` }));
  let calls = 0;
  const accepted = await confirmManualGradeScale([...suspicious, entry({ studentName: "Aprobado", finalGrade: 100 })], async context => {
    calls++;
    for (const grade of suspicious) assert.ok(context.message.includes(grade.studentName));
    assert.equal(context.message.includes("Aprobado"), false);
    assert.equal(context.confirmLabel, "Confirmar notas sobre 100");
    return false;
  });
  assert.equal(calls, 1);
  assert.equal(accepted, false);
});

test("invalid and out-of-range inputs are left to normal grade validation", () => {
  for (const finalGrade of [null, undefined, NaN, Infinity, -1, 101]) {
    assert.equal(getManualGradeScaleWarning(entry({ finalGrade })), null);
  }
});
