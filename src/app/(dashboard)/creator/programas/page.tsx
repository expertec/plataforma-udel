"use client";

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Plus, Trash2 } from "lucide-react";
import {
  createProgram,
  deleteProgram,
  getPrograms,
  Program,
  syncProgramsFromCourses,
  updateProgram,
} from "@/lib/firebase/programs-service";
import { Course, getCourses } from "@/lib/firebase/courses-service";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import type { User } from "firebase/auth";

export default function ProgramasPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q),
    );
  }, [programs, search]);

  const courseMap = useMemo(() => {
    return new Map(courses.map((course) => [course.id, course]));
  }, [courses]);

  const coursesByProgram = useMemo(() => {
    const map = new Map<string, Course[]>();
    courses.forEach((course) => {
      const program = (course.program ?? course.category ?? "").trim();
      if (!program) return;
      const list = map.get(program) ?? [];
      list.push(course);
      map.set(program, list);
    });
    return map;
  }, [courses]);

  const load = async () => {
    setLoading(true);
    try {
      const [programData, courseData] = await Promise.all([getPrograms(), getCourses()]);
      setPrograms(programData);
      setCourses(courseData);
    } catch (err) {
      console.error(err);
      toast.error("No se pudieron cargar los programas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Esperar a que exista usuario autenticado para evitar errores de permisos
    const unsub = auth.onAuthStateChanged((user) => {
      setCurrentUser(user);
      if (user) {
        load();
      }
    });
    return () => unsub();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      toast.error("Debes iniciar sesión para crear programas.");
      return;
    }
    if (!name.trim()) {
      toast.error("El nombre es obligatorio");
      return;
    }
    setSaving(true);
    try {
      const id = await createProgram({ name: name.trim(), description: description.trim(), coverUrl: coverUrl.trim() });
      setPrograms((prev) => [
        { id, name: name.trim(), description: description.trim(), coverUrl: coverUrl.trim(), courseIds: [], status: "active" },
        ...prev,
      ]);
      setName("");
      setDescription("");
      setCoverUrl("");
      toast.success("Programa creado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el programa");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteProgram(id);
      setPrograms((prev) => prev.filter((p) => p.id !== id));
      toast.success("Programa eliminado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo eliminar");
    } finally {
      setDeletingId(null);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncProgramsFromCourses();
      await load();
      toast.success("Programas sincronizados");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await updateProgram(id, { name: newName });
      setPrograms((prev) => prev.map((p) => (p.id === id ? { ...p, name: newName } : p)));
    } catch (err) {
      console.error(err);
      toast.error("No se pudo actualizar");
    }
  };

  return (
    <RoleGate allowedRole={["superAdminTeacher"]}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Catálogo</p>
            <h1 className="text-2xl font-semibold text-slate-900">Programas de estudio</h1>
            <p className="text-sm text-slate-600">
              Crea carreras y agrupa cursos bajo cada programa.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-blue-500 hover:text-blue-600 disabled:opacity-60"
            >
              {syncing ? "Sincronizando..." : "Sincronizar cursos"}
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar programa..."
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        </header>

        <form onSubmit={handleCreate} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-[2fr_2fr_2fr_auto] sm:items-end">
          <div>
            <label className="text-sm font-medium text-slate-800">Nombre del programa *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-800">Descripción</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-800">Cover (URL)</label>
            <input
              value={coverUrl}
              onChange={(e) => setCoverUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-70"
          >
            <Plus size={16} />
            {saving ? "Guardando..." : "Crear programa"}
          </button>
        </form>

        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <p className="text-sm font-semibold text-slate-900">Programas ({filtered.length})</p>
            {loading && <span className="text-xs text-slate-500">Cargando...</span>}
          </div>
          {filtered.length === 0 ? (
            <p className="p-4 text-sm text-slate-600">No hay programas aún.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {filtered.map((program) => (
                <div key={program.id} className="grid gap-3 px-4 py-3 sm:grid-cols-[1.5fr_2fr_auto] sm:items-start">
                  <div className="flex flex-col gap-1">
                    <input
                      defaultValue={program.name}
                      onBlur={(e) => {
                        const value = e.target.value.trim();
                        if (value && value !== program.name) {
                          handleRename(program.id, value);
                        } else {
                          e.target.value = program.name;
                        }
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <p className="text-xs text-slate-500">
                      {program.courseIds?.length ?? 0} curso(s) asignados
                    </p>
                  </div>
                  <div className="text-sm text-slate-700">
                    <p>{program.description || "Sin descripción"}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(() => {
                        const listedCourses =
                          program.courseIds?.map((id) => courseMap.get(id)).filter(Boolean) ?? [];
                        const fallback = coursesByProgram.get(program.name) ?? [];
                        const coursesToShow = listedCourses.length > 0 ? listedCourses : fallback;
                        if (coursesToShow.length === 0) {
                          return (
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">
                              Sin cursos asignados
                            </span>
                          );
                        }
                        return coursesToShow.map((course) => (
                          <span
                            key={course?.id}
                            className="rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700"
                          >
                            {course?.title ?? "Curso"}
                          </span>
                        ));
                      })()}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {program.coverUrl ? (
                      <a
                        href={program.coverUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Ver cover
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => handleDelete(program.id)}
                      disabled={deletingId === program.id}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
                    >
                      <Trash2 size={14} />
                      Eliminar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </RoleGate>
  );
}
