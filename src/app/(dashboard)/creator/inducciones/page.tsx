"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { onAuthStateChanged } from "firebase/auth";
import { BookOpen, ExternalLink, Loader2 } from "lucide-react";
import { type Course, getInductionCourses } from "@/lib/firebase/courses-service";
import { auth } from "@/lib/firebase/client";

export default function InductionsPage() {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        if (!active) return;
        setCourses([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const data = await getInductionCourses();
        if (active) setCourses(data);
      } catch (err) {
        console.error("No se pudieron cargar inducciones:", err);
        if (active) setError("No pudimos cargar las inducciones. Intenta recargar.");
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
      unsub();
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Inducciones</p>
          <h1 className="text-2xl font-semibold text-slate-900">Cursos de inducción</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Abre cada inducción en una ventana independiente con formato de curso en línea.
          </p>
        </div>
        <Link
          href="/creator/cursos"
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-600"
        >
          Administrar cursos
        </Link>
      </header>

      {error ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
          <Loader2 size={18} className="animate-spin" />
          Cargando inducciones...
        </div>
      ) : courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <BookOpen size={42} className="text-slate-400" />
          <h3 className="text-lg font-semibold text-slate-900">No hay inducciones disponibles</h3>
          <p className="max-w-md text-sm text-slate-600">
            Marca un curso como inducción desde su configuración para que aparezca aquí.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {courses.map((course) => (
            <Link
              key={course.id}
              href={`/inducciones/${course.id}`}
              target="_blank"
              rel="opener"
              className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
            >
              <div className="relative aspect-video w-full bg-slate-100">
                {course.thumbnail ? (
                  <Image
                    src={course.thumbnail}
                    alt={course.title}
                    fill
                    unoptimized
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-400">
                    <BookOpen size={44} />
                  </div>
                )}
              </div>
              <div className="flex min-h-52 flex-col gap-3 p-4">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                      Inducción
                    </span>
                    {course.program ? (
                      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {course.program}
                      </span>
                    ) : null}
                  </div>
                  <h2 className="line-clamp-2 text-lg font-semibold text-slate-900">
                    {course.title}
                  </h2>
                  <p className="mt-2 line-clamp-3 text-sm text-slate-600">
                    {course.description || "Sin descripción"}
                  </p>
                </div>
                <div className="mt-auto flex items-center justify-between gap-3 pt-2">
                  <p className="text-xs text-slate-500">
                    {course.lessonsCount ?? 0} lecciones
                  </p>
                  <span
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
                  >
                    Abrir curso
                    <ExternalLink size={15} />
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
