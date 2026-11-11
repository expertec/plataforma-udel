import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const loadedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../src/lib/program-level.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { exports: loadedModule.exports, module: loadedModule });
const { supportsClassroomActivities } = loadedModule.exports;

test("online high-school groups include classroom activities for teacher grading", () => {
  for (const program of ["Preparatoria", "Prepa online", "BACHILLERATO", "Educación Media Superior", " Preparatoria UDEL "]) {
    assert.equal(supportsClassroomActivities(program, false), true, program);
  }
});

test("in-person undergraduate grading remains available", () => {
  for (const program of ["Licenciatura", "Ingeniería", "TSU", "Lic. en Administración"]) {
    assert.equal(supportsClassroomActivities(program, true), true, program);
    assert.equal(supportsClassroomActivities(program, false), false, program);
  }
});

test("other programs and modalities keep their existing availability", () => {
  assert.equal(supportsClassroomActivities("Preparatoria", true), false);
  for (const program of ["Maestría", "Diplomado", "", undefined, null]) {
    for (const isInPerson of [true, false]) {
      assert.equal(supportsClassroomActivities(program, isInPerson), false);
    }
  }
});
