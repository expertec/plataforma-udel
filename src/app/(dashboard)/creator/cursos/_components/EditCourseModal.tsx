"use client";

import { useEffect, useState } from "react";
import {
  updateCourse,
  Course,
  publishCourse,
  deleteCourse,
} from "@/lib/firebase/courses-service";
import toast from "react-hot-toast";

type EditCourseModalProps = {
  open: boolean;
  onClose: () => void;
  course: Course | null;
  onUpdated: (courseId: string, data: Partial<Course>) => void;
  onDeleted: (courseId: string) => void;
};

export function EditCourseModal({
  open,
  onClose,
  course,
  onUpdated,
  onDeleted,
}: EditCourseModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [introVideoUrl, setIntroVideoUrl] = useState("");
  const [category, setCategory] = useState("");
  const [thumbnail, setThumbnail] = useState("");
  const [loading, setLoading] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  useEffect(() => {
    if (course) {
      setTitle(course.title || "");
      setDescription(course.description || "");
      setIntroVideoUrl(course.introVideoUrl || "");
      setCategory(course.category || "");
      setThumbnail(course.thumbnail || "");
      setConfirmName("");
    }
  }, [course]);

  if (!open || !course) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await updateCourse(course.id, {
        title: title.trim(),
        description: description.trim(),
        introVideoUrl: introVideoUrl.trim(),
        category,
        thumbnail: thumbnail.trim(),
      });
      onUpdated(course.id, {
        title: title.trim(),
        description: description.trim(),
        introVideoUrl: introVideoUrl.trim(),
        category,
        thumbnail: thumbnail.trim(),
      });
      toast.success("Curso actualizado");
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo actualizar el curso");
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublish = async () => {
    if (!course) return;
    setPublishLoading(true);
    const next = !course.isPublished;
    try {
      await publishCourse(course.id, next);
      onUpdated(course.id, { isPublished: next });
      toast.success(next ? "Curso publicado" : "Curso en borrador");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo actualizar el estado de publicación");
    } finally {
      setPublishLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!course) return;
    if (confirmName.trim() !== course.title.trim()) {
      toast.error("Escribe exactamente el nombre del curso para confirmar");
      return;
    }
    setDeleteLoading(true);
    try {
      await deleteCourse(course.id);
      onDeleted(course.id);
      toast.success("Curso eliminado");
      onClose();
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar el curso");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
      <div className="w-full max-w-2xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Editar curso</h2>
            <p className="text-sm text-slate-600">Configura la información del curso.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTogglePublish}
              disabled={publishLoading}
              className={`rounded-lg px-4 py-2 text-sm font-semibold shadow-sm transition ${
                course.isPublished
                  ? "border border-slate-200 bg-white text-slate-800 hover:border-blue-200"
                  : "bg-blue-600 text-white hover:bg-blue-500"
              } disabled:cursor-not-allowed disabled:opacity-70`}
            >
              {publishLoading
                ? "Actualizando..."
                : course.isPublished
                  ? "Mover a borrador"
                  : "Publicar"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cerrar
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-800">Título</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Descripción</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-800">
                URL video introducción
              </label>
              <input
                value={introVideoUrl}
                onChange={(e) => setIntroVideoUrl(e.target.value)}
                placeholder="https://..."
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-800">Categoría</label>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Thumbnail (URL)</label>
            <input
              value={thumbnail}
              onChange={(e) => setThumbnail(e.target.value)}
              placeholder="https://..."
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
              {loading ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        </form>

        <div className="mt-6 rounded-xl border border-red-100 bg-red-50 p-4">
          <h3 className="text-sm font-semibold text-red-700">Eliminar curso</h3>
          <p className="mt-1 text-sm text-red-600">
            Esta acción es irreversible. Escribe <strong>{course.title}</strong> para confirmar.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={course.title}
              className="w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-red-400 focus:outline-none focus:ring-1 focus:ring-red-300"
            />
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleteLoading}
              className="whitespace-nowrap rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {deleteLoading ? "Eliminando..." : "Eliminar curso"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
