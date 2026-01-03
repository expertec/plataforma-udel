"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { createLesson } from "@/lib/firebase/courses-service";

type AddLessonModalProps = {
  open: boolean;
  onClose: () => void;
  courseId: string;
  nextNumber: number;
  onCreated: (lessonId: string, payload: { lessonNumber: number; title: string; description: string; order: number }) => void;
};

export function AddLessonModal({
  open,
  onClose,
  courseId,
  nextNumber,
  onCreated,
}: AddLessonModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [lessonNumber, setLessonNumber] = useState<number>(nextNumber);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("El título es obligatorio");
      return;
    }
    setLoading(true);
    const order = nextNumber - 1;
    try {
      const lessonId = await createLesson({
        courseId,
        title: title.trim(),
        description: description.trim(),
        lessonNumber,
        order,
      });
      onCreated(lessonId, { lessonNumber, title: title.trim(), description: description.trim(), order });
      toast.success("Lección creada");
      onClose();
      setTitle("");
      setDescription("");
      setLessonNumber(nextNumber + 1);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear la lección");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Nueva Lección</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-800">
              Número de lección
            </label>
            <input
              type="number"
              min={1}
              value={lessonNumber}
              onChange={(e) => setLessonNumber(Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-800">
              Título *
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-800">
              Descripción (opcional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? "Creando..." : "Crear"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
