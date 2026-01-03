"use client";

import { useEffect, useState } from "react";
import {
  QuizQuestion,
  createQuizQuestion,
  deleteQuizQuestion,
  getQuizQuestions,
} from "@/lib/firebase/courses-service";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";

type QuizQuestionsModalProps = {
  open: boolean;
  onClose: () => void;
  courseId: string;
  lessonId: string;
  classId: string;
  classTitle: string;
};

type DraftOption = { id: string; text: string; isCorrect: boolean };

export function QuizQuestionsModal({
  open,
  onClose,
  courseId,
  lessonId,
  classId,
  classTitle,
}: QuizQuestionsModalProps) {
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState<DraftOption[]>([
    { id: uuidv4(), text: "", isCorrect: true },
    { id: uuidv4(), text: "", isCorrect: false },
  ]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getQuizQuestions(courseId, lessonId, classId)
      .then(setQuestions)
      .finally(() => setLoading(false));
  }, [open, courseId, lessonId, classId]);

  const resetForm = () => {
    setPrompt("");
    setOptions([
      { id: uuidv4(), text: "", isCorrect: true },
      { id: uuidv4(), text: "", isCorrect: false },
    ]);
  };

  const handleAddQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) {
      toast.error("La pregunta es obligatoria");
      return;
    }
    const opts = options.filter((o) => o.text.trim().length > 0);
    if (opts.length < 2 || !opts.some((o) => o.isCorrect)) {
      toast.error("Agrega al menos 2 opciones y marca una correcta");
      return;
    }
    setSaving(true);
    try {
      const id = await createQuizQuestion({
        courseId,
        lessonId,
        classId,
        prompt: prompt.trim(),
        options: opts,
        order: questions.length,
      });
      setQuestions((prev) => [
        ...prev,
        {
          id,
          prompt: prompt.trim(),
          options: opts,
          order: questions.length,
          type: "multiple",
        },
      ]);
      resetForm();
      toast.success("Pregunta agregada");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo agregar la pregunta");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!confirm("¿Eliminar esta pregunta?")) return;
    try {
      await deleteQuizQuestion(courseId, lessonId, classId, questionId);
      setQuestions((prev) => prev.filter((q) => q.id !== questionId));
      toast.success("Pregunta eliminada");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar");
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Quiz</p>
            <h2 className="text-lg font-semibold text-slate-900">
              Preguntas de: {classTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-[1.3fr_1fr]">
          <form onSubmit={handleAddQuestion} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <label className="text-sm font-medium text-slate-800">Pregunta</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />

            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-800">Opciones</p>
              {options.map((opt, idx) => (
                <div key={opt.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correctOption"
                    checked={opt.isCorrect}
                    onChange={() =>
                      setOptions((prev) =>
                        prev.map((o) =>
                          o.id === opt.id ? { ...o, isCorrect: true } : { ...o, isCorrect: false },
                        ),
                      )
                    }
                    className="h-4 w-4 text-blue-600"
                  />
                  <input
                    value={opt.text}
                    onChange={(e) =>
                      setOptions((prev) =>
                        prev.map((o) => (o.id === opt.id ? { ...o, text: e.target.value } : o)),
                      )
                    }
                    placeholder={`Opción ${idx + 1}`}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  {options.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => setOptions((prev) => prev.filter((o) => o.id !== opt.id))}
                      className="text-sm text-red-500 hover:text-red-700"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setOptions((prev) => [...prev, { id: uuidv4(), text: "", isCorrect: false }])}
                className="text-sm font-medium text-blue-600 hover:underline"
              >
                + Agregar opción
              </button>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-60"
              >
                {saving ? "Guardando..." : "Guardar pregunta"}
              </button>
            </div>
          </form>

          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-800">Preguntas existentes</p>
            {loading ? (
              <p className="text-sm text-slate-600">Cargando...</p>
            ) : questions.length === 0 ? (
              <p className="text-sm text-slate-500">Aún no hay preguntas.</p>
            ) : (
              <div className="space-y-2">
                {questions
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((q) => (
                    <div
                      key={q.id}
                      className="rounded-lg border border-slate-200 bg-white p-3 text-sm"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-slate-900">{q.prompt}</p>
                        <button
                          type="button"
                          onClick={() => handleDeleteQuestion(q.id)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Eliminar
                        </button>
                      </div>
                      <ul className="mt-2 space-y-1">
                        {q.options.map((opt) => (
                          <li key={opt.id} className="flex items-center gap-2">
                            <span
                              className={`inline-flex h-5 w-5 items-center justify-center rounded-full border ${
                                opt.isCorrect
                                  ? "border-green-500 text-green-600"
                                  : "border-slate-300 text-slate-500"
                              }`}
                            >
                              {opt.isCorrect ? "✓" : ""}
                            </span>
                            <span className="text-slate-700">{opt.text}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
