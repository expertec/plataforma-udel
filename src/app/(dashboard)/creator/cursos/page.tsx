"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Course, getCourses, publishCourse } from "@/lib/firebase/courses-service";
import { EditCourseModal } from "./_components/EditCourseModal";
import { CreateCourseModal } from "./_components/CreateCourseModal";
import { BulkUploadCoursesModal } from "./_components/BulkUploadCoursesModal";
import toast from "react-hot-toast";

export default function CoursesPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);

  const loadCourses = useCallback(
    async (uid: string) => {
      setLoading(true);
      try {
        const data = await getCourses(uid);
        setCourses(data);
      } finally {
        setLoading(false);
      }
    },
    [setCourses],
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setCourses([]);
        setLoading(false);
        return;
      }
      loadCourses(user.uid);
    });
    return () => unsub();
  }, [loadCourses]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
            Cursos
          </p>
          <h1 className="text-2xl font-semibold text-slate-900">Mis Cursos</h1>
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

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          Cargando cursos...
        </div>
      ) : courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <div className="text-4xl">📚</div>
          <h3 className="text-lg font-semibold text-slate-900">
            Aún no tienes cursos
          </h3>
          <p className="text-sm text-slate-600">
            Crea tu primer curso y empieza a compartir conocimiento.
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
          >
            + Crear Primer Curso
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((course) => (
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
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">
                    Sin thumbnail
                  </div>
                )}
              </div>
              <div className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {course.title}
                    </h3>
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
                      className="text-xs font-medium text-slate-700 hover:underline"
                    >
                      Editar
                    </button>
                    <button
                      onClick={async (e) => {
                        e.preventDefault();
                        const next = !course.isPublished;
                        setCourses((prev) =>
                          prev.map((c) =>
                            c.id === course.id ? { ...c, isPublished: next } : c,
                          ),
                        );
                        try {
                          await publishCourse(course.id, next);
                          toast.success(next ? "Curso publicado" : "Curso en borrador");
                        } catch {
                          toast.error("No se pudo actualizar estado");
                        }
                      }}
                      className="text-xs font-medium text-blue-600 hover:underline"
                    >
                      {course.isPublished ? "Pasar a borrador" : "Publicar"}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm text-slate-600">
                  <span>{course.lessonsCount ?? 0} lecciones</span>
                  <span>•</span>
                  <span>{course.studentsCount ?? 0} alumnos</span>
                </div>
                <div className="flex items-center justify-between pt-2">
                  <a
                    href={`/creator/cursos/${course.id}`}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800 transition hover:border-blue-500 hover:text-blue-600"
                  >
                    Editar
                  </a>
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    ⋮
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <CreateCourseModal open={modalOpen} onClose={() => setModalOpen(false)} />
      <EditCourseModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        course={editingCourse}
        onUpdated={(id, data) => {
          setCourses((prev) =>
            prev.map((c) => (c.id === id ? { ...c, ...data } : c)),
          );
        }}
      />
      <BulkUploadCoursesModal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        teacherId={currentUser?.uid}
        teacherName={currentUser?.displayName ?? ""}
        onImported={async () => {
          if (currentUser?.uid) {
            await loadCourses(currentUser.uid);
          }
        }}
      />
    </div>
  );
}
