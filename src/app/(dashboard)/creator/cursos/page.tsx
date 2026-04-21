"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { onAuthStateChanged, User } from "firebase/auth";
import { Copy, Loader2, Settings2 } from "lucide-react";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import { Course, duplicateCourse, getCourses } from "@/lib/firebase/courses-service";
import { isAdminTeacherRole, resolveUserRole, UserRole } from "@/lib/firebase/roles";
import { EditCourseModal } from "./_components/EditCourseModal";
import { CreateCourseModal } from "./_components/CreateCourseModal";
import { BulkUploadCoursesModal } from "./_components/BulkUploadCoursesModal";

const formatCreationDate = (value?: Date): string => {
  if (!value || Number.isNaN(value.getTime())) return "Sin fecha registrada";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
};

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [duplicatingCourseId, setDuplicatingCourseId] = useState<string | null>(null);
  const PAGE_SIZE = 9;

  const loadCourses = useCallback(
    async (uid: string | null, role: UserRole | null) => {
      if (!uid) {
        setCourses([]);
        setLoading(false);
        setLoadError(null);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const teacherId = isAdminTeacherRole(role) ? undefined : uid;
        const data = await getCourses(teacherId);
        setCourses(data);
      } catch (err) {
        console.error("No se pudieron cargar cursos:", err);
        setLoadError("No pudimos cargar los cursos. Verifica la conexión y vuelve a intentar.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setCourses([]);
        setUserRole(null);
        setLoadError(null);
        setLoading(false);
        return;
      }
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
        await loadCourses(user.uid, role);
      } catch (err) {
        console.error("No se pudo resolver rol de profesor:", err);
        setLoadError("No pudimos validar tu sesión. Intenta recargar.");
        setLoading(false);
      }
    });
    return () => unsub();
  }, [loadCourses]);

  const filteredCourses = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    if (!normalizedSearch) return courses;
    return courses.filter((course) => {
      const haystack = `${course.title} ${course.description ?? ""} ${course.program ?? course.category ?? ""}`.toLowerCase();
      return haystack.includes(normalizedSearch);
    });
  }, [courses, searchTerm]);

  const totalPages = Math.max(1, Math.ceil(filteredCourses.length / PAGE_SIZE));
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedCourses = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredCourses.slice(start, start + PAGE_SIZE);
  }, [filteredCourses, currentPage]);
  const showCreationMetadata = isAdminTeacherRole(userRole);

  const handleDuplicateCourse = async (course: Course) => {
    if (!currentUser || !isAdminTeacherRole(userRole)) {
      toast.error("Solo adminTeacher puede duplicar cursos");
      return;
    }

    const confirmed = window.confirm(`¿Duplicar el curso "${course.title}"?`);
    if (!confirmed) return;

    setDuplicatingCourseId(course.id);
    try {
      await duplicateCourse({
        sourceCourseId: course.id,
        teacherId: currentUser.uid,
        teacherName: currentUser.displayName ?? "",
      });
      await loadCourses(currentUser.uid, userRole);
      toast.success("Curso duplicado correctamente");
    } catch (error) {
      console.error("No se pudo duplicar el curso:", error);
      toast.error("No se pudo duplicar el curso");
    } finally {
      setDuplicatingCourseId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
            Cursos
          </p>
          <h1 className="text-2xl font-semibold text-slate-900">
            {isAdminTeacherRole(userRole) ? "Cursos de la plataforma" : "Mis Cursos"}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
          >
            + Crear Nuevo Curso
          </button>
          <button
            onClick={() => setBulkModalOpen(true)}
            className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-600"
          >
            📥 Cargar desde Excel
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
          Buscar curso
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Título, descripción, programa..."
            className="w-full rounded-lg border border-slate-200 p-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <p className="text-xs text-slate-500">
          Mostrando {filteredCourses.length} de {courses.length} cursos cargados
        </p>
      </div>
      {loadError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm">
          {loadError}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Cargando cursos...
        </div>
      ) : filteredCourses.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <div className="text-4xl">📚</div>
          <h3 className="text-lg font-semibold text-slate-900">
            {courses.length === 0 ? "Aún no tienes cursos" : "No se encontraron cursos"}
          </h3>
          <p className="text-sm text-slate-600">
            {courses.length === 0
              ? "Crea tu primer curso y empieza a compartir conocimiento."
              : "Prueba otra palabra clave o elimina los filtros para ver más resultados."}
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
          >
            + Crear Primer Curso
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {paginatedCourses.map((course) => (
              <article
                key={course.id}
                className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
              >
                <div className="relative h-36 w-full bg-slate-100">
                  {course.thumbnail ? (
                    <Image
                      src={course.thumbnail}
                      alt={course.title}
                      fill
                      className="object-cover"
                      sizes="(min-width: 1280px) 30vw, (min-width: 768px) 45vw, 100vw"
                      unoptimized
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">
                      Sin thumbnail
                    </div>
                  )}
                </div>
                <div className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-semibold text-slate-900">
                          {course.title}
                        </h3>
                        {course.isMentorCourse && (
                          <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700">
                            Mentor
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 line-clamp-2">
                        {course.description || "Sin descripción"}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-2 text-right text-sm font-semibold">
                      <span
                        className={
                          course.isPublished ? "text-green-600" : "text-slate-500"
                        }
                      >
                        {course.isPublished ? "Publicado" : "Borrador"}
                      </span>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          setEditingCourse(course);
                          setEditModalOpen(true);
                        }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-700 shadow-sm transition hover:border-blue-300 hover:text-blue-700"
                        aria-label="Configurar curso"
                      >
                        <Settings2 size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-slate-600">
                    <span>{course.lessonsCount ?? 0} lecciones</span>
                    <span>•</span>
                    <span>{course.studentsCount ?? 0} alumnos</span>
                  </div>
                  {showCreationMetadata ? (
                    <p className="text-xs text-slate-500">
                      Creado: {formatCreationDate(course.createdAt)}
                    </p>
                  ) : null}
                  <div className="flex items-center justify-between pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/creator/cursos/${course.id}`}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800 transition hover:border-blue-500 hover:text-blue-600"
                      >
                        Abrir curso
                      </a>
                      {isAdminTeacherRole(userRole) ? (
                        <button
                          type="button"
                          onClick={() => void handleDuplicateCourse(course)}
                          disabled={duplicatingCourseId === course.id}
                          className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          {duplicatingCourseId === course.id ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              Duplicando...
                            </>
                          ) : (
                            <>
                              <Copy size={14} />
                              Duplicar
                            </>
                          )}
                        </button>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                      ⋮
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-xs text-slate-600 shadow-sm">
            <span>
              Página {currentPage} de {totalPages}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                className="rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 transition hover:border-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                Anterior
              </button>
              <button
                type="button"
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                className="rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-slate-700 transition hover:border-blue-500 hover:text-blue-600 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}

      <CreateCourseModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <EditCourseModal
        open={editModalOpen}
        onClose={() => {
          setEditModalOpen(false);
          setEditingCourse(null);
        }}
        course={editingCourse}
        onUpdated={(id, data) => {
          setCourses((prev) =>
            prev.map((c) => (c.id === id ? { ...c, ...data } : c)),
          );
        }}
        onDeleted={(id) => {
          setCourses((prev) => prev.filter((c) => c.id !== id));
        }}
      />
      <BulkUploadCoursesModal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        teacherId={currentUser?.uid}
        teacherName={currentUser?.displayName ?? ""}
        onImported={async () => {
          if (currentUser?.uid) {
            await loadCourses(currentUser.uid, userRole);
          }
        }}
      />
    </div>
  );
}
