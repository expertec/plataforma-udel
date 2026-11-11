import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
function load(file) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute);
  const mod = { exports: {} };
  cache.set(absolute, mod.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    module: mod, exports: mod.exports, Uint8Array,
    require: id => {
      // The import runs in the browser in production; exercise that same build.
      if (id === 'mammoth') return require('mammoth/mammoth.browser.js');
      if (id === 'next/server') return { NextResponse: { json: (body, init) => ({ body, ...init }) } };
      if (id === '@/lib/firebase/admin') return {};
      if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
      if (id.startsWith('.')) return load(path.resolve(path.dirname(absolute), `${id}.ts`));
      return require(id);
    },
  });
  return mod.exports;
}
const { parseGlobalExamQuestionsFromTemplateFile: parse, parseExamTemplatePreviewQuestions: preview } = load('src/lib/global-exams/word-import.ts');
const { normalizeGlobalExamQuestions, GlobalExamValidationError } = load('src/lib/global-exams/types.ts');
const { toGlobalExamRouteErrorResponse } = load('src/lib/server/global-exams-access.ts');
const question = (n, score = '1') => `${n}\nPregunta de ejemplo ${n}\n${score}\na)\nPrimera opción\nb)\nSegunda opción\ncorrecta\nc)\nTercera opción`;
const file = text => new File([text], 'examen.doc', { type: 'application/msword' });

test('institutional scores do not split questions, and correcta selects B', async () => {
  const source = file(Array.from({ length: 20 }, (_, i) => question(i + 1)).join('\n\n'));
  const questions = normalizeGlobalExamQuestions(await parse(source));
  assert.equal(questions.length, 20);
  for (const [i, q] of questions.entries()) {
    assert.equal(q.prompt, `Pregunta de ejemplo ${i + 1}`);
    assert.equal(q.options.length, 3);
    assert.equal(q.correctOptionId, 'b');
  }
  const visible = await preview(source);
  assert.equal(visible.length, 20);
  assert.equal(visible[19].options.length, 3);
});

test('inline numbering, decimal scores, and explicit answers remain readable', async () => {
  const source = file('1. ¿Cuál opción?\nPuntaje: 1\nA) Uno\nB) Dos\nRespuesta correcta: B\nRetroalimentación: Revisa la lectura.\n' + question(2, '0,5'));
  const questions = normalizeGlobalExamQuestions(await parse(source));
  assert.equal(questions.length, 2);
  assert.equal(questions[0].correctOptionId, 'b');
  assert.equal(questions[0].feedback, 'Revisa la lectura.');
  assert.equal(questions[1].options.length, 3);
});

test('the downloadable institutional DOCX parses all twenty questions', async () => {
  const source = new File([fs.readFileSync('public/templates/materia-formato-institucional-udel.docx')], 'institucional.docx');
  const questions = normalizeGlobalExamQuestions(await parse(source));
  assert.equal(questions.length, 20);
  assert.ok(questions.every(q => q.options.length === 3));
  assert.equal((await preview(source)).length, 20);
});

test('binary DOC is rejected with conversion instructions, including renamed files', async () => {
  const bytes = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (const name of ['antiguo.doc', 'renombrado.docx']) {
    for (const read of [parse, preview]) {
      await assert.rejects(read(new File([bytes], name)), /guárdalo como Documento de Word \(\.docx\)/);
    }
  }
});

test('HTML Word files still import options and the explicit answer', async () => {
  const questions = await parse(file('<html><body><p>1. ¿Qué opción?</p><p>A) Uno</p><p>B) Dos</p><p>Respuesta correcta: B</p></body></html>'));
  assert.equal(questions.length, 1);
  assert.equal(questions[0].correctOptionId, 'b');
});

test('invalid exam data returns HTTP 400 with its actionable validation message', () => {
  for (const input of [[], [{ prompt: 'Pregunta', options: [{ text: 'Una' }], correctOptionId: 'a' }]]) {
    let error;
    try { normalizeGlobalExamQuestions(input); } catch (caught) { error = caught; }
    assert.ok(error instanceof GlobalExamValidationError);
    const response = toGlobalExamRouteErrorResponse(error, 'Test');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, error.message);
  }
});
