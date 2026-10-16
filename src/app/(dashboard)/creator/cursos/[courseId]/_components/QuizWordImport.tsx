"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { extractWordCourseTemplateText } from "@/lib/course-word-template-docx";
import { parseWordCourseTemplate, type WordImportedClass, type WordImportedQuizQuestion } from "@/lib/course-word-template-parser";

export function QuizWordImport({ onImport }: { onImport: (questions: WordImportedQuizQuestion[]) => void }) {
  const [loading, setLoading] = useState(false);
  const [quizzes, setQuizzes] = useState<WordImportedClass[]>([]);
  const [selected, setSelected] = useState(0);
  const questions = quizzes[selected]?.quizQuestions ?? [];
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700">
      <label className="block font-semibold">
        Cargar plantilla Word (.docx)
        <input type="file" accept=".docx" disabled={loading} className="mt-2 block w-full text-xs" onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          if (!file.name.toLowerCase().endsWith(".docx") || file.size > 20 * 1024 * 1024) { toast.error("Selecciona un archivo .docx de hasta 20 MB."); return; }
          setLoading(true);
          setQuizzes([]);
          try {
            const result = await extractWordCourseTemplateText({ arrayBuffer: await file.arrayBuffer() });
            const parsed = parseWordCourseTemplate(result.value, "Semana 5").flatMap((lesson) => lesson.classes).filter((item) => item.type === "quiz" && item.quizQuestions?.length);
            if (!parsed.length) throw new Error("No se encontraron preguntas. Utiliza la misma estructura de las plantillas de quizzes semanales.");
            setQuizzes(parsed);
            setSelected(0);
          } catch (error) { toast.error(error instanceof Error ? error.message : "No se pudo leer la plantilla."); }
          finally { setLoading(false); }
        }} />
      </label>
      {loading ? <p>Leyendo plantilla…</p> : null}
      {quizzes.length > 0 ? <>
        {quizzes.length > 1 ? <select className="w-full rounded border p-2" value={selected} onChange={(event) => setSelected(Number(event.target.value))}>{quizzes.map((quiz, index) => <option value={index} key={index}>{quiz.title} ({quiz.quizQuestions?.length} preguntas)</option>)}</select> : null}
        <p className="font-semibold">Vista previa: {questions.length} preguntas. Al aplicar se reemplazan los reactivos del editor.</p>
        <ol className="max-h-64 list-decimal space-y-3 overflow-y-auto pl-5">
          {questions.map((question, index) => <li key={index}>
            <p>{question.prompt}</p>
            {question.options.map((option, optionIndex) => <p key={optionIndex} className={option.isCorrect ? "font-semibold text-emerald-700" : ""}>{option.isCorrect ? "✓ " : ""}{option.text}</p>)}
            {question.explanation ? <p className="text-xs text-slate-500">Retroalimentación: {question.explanation}</p> : null}
          </li>)}
        </ol>
        <button type="button" className="rounded bg-slate-900 px-3 py-2 font-semibold text-white" onClick={() => { onImport(questions); setQuizzes([]); }}>Usar estas preguntas</button>
        <button type="button" className="ml-3" onClick={() => setQuizzes([])}>Cancelar carga</button>
      </> : null}
    </div>
  );
}
