"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { createGroup, Group } from "@/lib/firebase/groups-service";

type CourseOption = { id: string; title: string };

type Props = {
  open: boolean;
  onClose: () => void;
  courses: CourseOption[];
  teacherId: string;
  teacherName: string;
  onCreated: (group: Group) => void;
};

const semesterOptions = ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"];

export function CreateGroupModal({ open, onClose, courses, teacherId, teacherName, onCreated }: Props) {
  const [courseId, setCourseId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupName, setGroupName] = useState("");
  const [semester, setSemester] = useState(semesterOptions[1] ?? "2025-1");
  const [maxStudents, setMaxStudents] = useState(30);
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const uniqueIds = Array.from(new Set([courseId, ...selectedIds].filter(Boolean)));
    if (uniqueIds.length === 0) {
      toast.error("Selecciona al menos una materia/curso");
      return;
    }
    if (!groupName.trim()) {
      toast.error("El nombre del grupo es obligatorio");
      return;
    }
    if (maxStudents <= 0) {
      toast.error("El cupo debe ser mayor a 0");
      return;
    }

    const selectedCourse = courses.find((c) => c.id === courseId || c.id === uniqueIds[0]);
    if (!selectedCourse) {
      toast.error("Curso inválido");
      return;
    }
    const coursesPayload =
      uniqueIds
        .map((id) => {
          const found = courses.find((c) => c.id === id);
          return found ? { courseId: found.id, courseName: found.title } : null;
        })
        .filter(Boolean) as Array<{ courseId: string; courseName: string }>;

    setSaving(true);
    try {
      const groupId = await createGroup({
        courseId,
        courseName: selectedCourse.title,
        courses: coursesPayload,
        groupName: groupName.trim(),
        teacherId,
        teacherName,
        semester,
        maxStudents,
      });

      onCreated({
        id: groupId,
        courseId,
        courseName: selectedCourse.title,
        courses: coursesPayload,
        groupName: groupName.trim(),
        teacherId,
        teacherName,
        semester,
        startDate: null,
        endDate: null,
        status: "active",
        studentsCount: 0,
        maxStudents,
      });
      toast.success("Grupo creado");
      onClose();
      setGroupName("");
      setMaxStudents(30);
      setSelectedIds([]);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el grupo");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Crear Nuevo Grupo</h2>
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
            <label className="text-sm font-medium text-slate-800">Selecciona el curso base</label>
            <select
              value={courseId}
              onChange={(e) => setCourseId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Selecciona un curso</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Curso base para el feed principal de los estudiantes.
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              Asignar más materias (opcional)
            </label>
            <div className="mt-2 grid max-h-40 grid-cols-1 gap-2 overflow-auto rounded-lg border border-slate-200 p-3">
              {courses.map((c) => {
                const checked = selectedIds.includes(c.id);
                return (
                  <label key={c.id} className="flex items-center gap-2 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      checked={checked || c.id === courseId}
                      disabled={c.id === courseId}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedIds((prev) => Array.from(new Set([...prev, c.id])));
                        } else {
                          setSelectedIds((prev) => prev.filter((id) => id !== c.id));
                        }
                      }}
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 disabled:cursor-not-allowed"
                    />
                    <span className={c.id === courseId ? "font-semibold" : ""}>{c.title}</span>
                    {c.id === courseId ? (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                        Base
                      </span>
                    ) : null}
                  </label>
                );
              })}
              {courses.length === 0 ? (
                <p className="text-xs text-slate-500">Crea cursos para asignarlos al grupo.</p>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Los alumnos verán las materias asignadas en su feed por curso.
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Nombre del grupo</label>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Ej: Grupo A - Enero 2025"
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-800">Semestre</label>
              <select
                value={semester}
                onChange={(e) => setSemester(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {semesterOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-800">Cupo máximo</label>
              <input
                type="number"
                min={1}
                value={maxStudents}
                onChange={(e) => setMaxStudents(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
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
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {saving ? "Creando..." : "Crear Grupo"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
