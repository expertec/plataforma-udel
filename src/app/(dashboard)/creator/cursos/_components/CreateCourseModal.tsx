"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { createCourse } from "@/lib/firebase/courses-service";
import { auth } from "@/lib/firebase/client";
import { getPrograms } from "@/lib/firebase/programs-service";

type CreateCourseModalProps = {
  open: boolean;
  onClose: () => void;
};

export function CreateCourseModal({ open, onClose }: CreateCourseModalProps) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [introVideoUrl, setIntroVideoUrl] = useState("");
  const [program, setProgram] = useState("");
  const [programOptions, setProgramOptions] = useState<string[]>([]);
  const [programLoading, setProgramLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const loadPrograms = async () => {
      setProgramLoading(true);
      try {
        const data = await getPrograms();
        if (!active) return;
        const names = Array.from(
          new Set(data.map((p) => p.name).filter(Boolean)),
        );
        setProgramOptions(names);
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar los programas");
      } finally {
        if (active) setProgramLoading(false);
      }
    };
    loadPrograms();
    return () => {
      active = false;
    };
  }, [open]);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setIntroVideoUrl("");
    setProgram("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast.error("El título es obligatorio");
      return;
    }
    const user = auth.currentUser;
    if (!user) {
      toast.error("Debes iniciar sesión");
      return;
    }
    setLoading(true);
    try {
      const courseId = await createCourse({
        title: title.trim(),
        description: description.trim(),
        introVideoUrl: introVideoUrl.trim(),
        program,
        teacherId: user.uid,
        teacherName: user.displayName ?? "",
      });
      toast.success("Curso creado");
      resetForm();
      onClose();
      router.push(`/creator/cursos/${courseId}`);
    } catch (error) {
      console.error(error);
      toast.error("No se pudo crear el curso");
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
      <div className="w-full max-w-2xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">
            Crear Nuevo Curso
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-800">
              Título del curso *
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              Descripción corta
            </label>
            <textarea
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              URL del video de introducción (opcional)
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              value={introVideoUrl}
              onChange={(e) => setIntroVideoUrl(e.target.value)}
              placeholder="https://..."
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              Programa / carrera
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              value={program}
              onChange={(e) => setProgram(e.target.value)}
            >
              <option value="">{programLoading ? "Cargando..." : "Seleccionar"}</option>
              {!programLoading && programOptions.length === 0 ? (
                <option value="" disabled>
                  No hay programas
                </option>
              ) : null}
              {programOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Administra los programas en la pestaña &quot;Programas&quot;.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                resetForm();
                onClose();
              }}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {loading ? "Creando..." : "Crear Curso y Continuar"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
