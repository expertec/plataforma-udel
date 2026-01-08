"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Course, getCourses } from "@/lib/firebase/courses-service";
import { Group, getGroupsForTeacher } from "@/lib/firebase/groups-service";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";

export default function CreatorPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setCourses([]);
        setGroups([]);
        setUserRole(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
        const teacherId = role === "adminTeacher" ? undefined : user.uid;
        const [coursesData, groupsData] = await Promise.all([
          getCourses(teacherId),
          getGroupsForTeacher(user.uid),
        ]);
        setCourses(coursesData);
        setGroups(groupsData);
      } finally {
        setLoading(false);
      }
    });

    return () => unsub();
  }, []);

  const publishedCourses = useMemo(
    () => courses.filter((course) => course.isPublished).length,
    [courses],
  );
  const activeGroups = useMemo(
    () => groups.filter((group) => group.status === "active").length,
    [groups],
  );
  const totalStudents = useMemo(
    () => groups.reduce((acc, group) => acc + (group.studentsCount ?? 0), 0),
    [groups],
  );
  const totalCapacity = useMemo(
    () => groups.reduce((acc, group) => acc + (group.maxStudents ?? 0), 0),
    [groups],
  );
  const fillRate =
    totalCapacity > 0 ? Math.min(100, Math.round((totalStudents / totalCapacity) * 100)) : 0;

  const topCourses = useMemo(
    () =>
      [...courses]
        .sort((a, b) => (b.studentsCount ?? 0) - (a.studentsCount ?? 0))
        .slice(0, 3),
    [courses],
  );

  const recentGroups = useMemo(
    () =>
      [...groups]
        .sort(
          (a, b) =>
            (b.createdAt?.getTime?.() ?? 0) -
            (a.createdAt?.getTime?.() ?? 0),
        )
        .slice(0, 4),
    [groups],
  );

  const nextStart = useMemo(() => {
    const upcoming = groups
      .filter((g) => g.startDate)
      .sort(
        (a, b) =>
          (a.startDate?.getTime?.() ?? Number.POSITIVE_INFINITY) -
          (b.startDate?.getTime?.() ?? Number.POSITIVE_INFINITY),
      );
    return upcoming[0] ?? null;
  }, [groups]);

  const name = currentUser?.displayName ?? "Profesor";

  return (
    <div className="space-y-6 text-slate-900">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Dashboard</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-slate-900">
              Hola, {name}
            </h1>
            <p className="text-sm text-slate-600">
              Resumen de tu actividad docente, alumnos inscritos y rendimiento de tus cohortes.
            </p>
          </div>
          {userRole === "adminTeacher" ? (
            <Link
              href="/creator/grupos"
              className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
            >
              + Crear nuevo grupo
            </Link>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Cursos"
          value={courses.length.toString()}
          accent="from-blue-100/80 via-white to-white"
          description={`${publishedCourses} publicados`}
        />
        <KpiCard
          title="Grupos activos"
          value={activeGroups.toString()}
          accent="from-emerald-100/80 via-white to-white"
          description={`${groups.length} en total`}
        />
        <KpiCard
          title="Alumnos inscritos"
          value={totalStudents.toString()}
          accent="from-amber-100/80 via-white to-white"
          description={
            totalCapacity > 0
              ? `${Math.max(totalCapacity - totalStudents, 0)} cupos disponibles`
              : "Define cupos en tus grupos"
          }
        />
        <KpiCard
          title="Ocupación promedio"
          value={`${fillRate}%`}
          accent="from-indigo-100/70 via-white to-white"
          description={
            totalCapacity > 0
              ? `Sobre ${totalCapacity} cupos`
              : "Añade capacidad a tus grupos"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section className="space-y-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-white via-white to-slate-50 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Cohortes
              </p>
              <h2 className="text-lg font-semibold text-slate-900">Actividad reciente</h2>
            </div>
            <Link
              href="/creator/grupos"
              className="text-sm font-medium text-blue-700 hover:underline"
            >
              Ver grupos
            </Link>
          </div>
          {loading ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600">
              Cargando datos...
            </div>
          ) : recentGroups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600">
              Aún no tienes grupos creados. Crea uno para empezar a seguir el progreso.
            </div>
          ) : (
            <div className="space-y-3">
              {recentGroups.map((group) => (
                <article
                  key={group.id}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-slate-500">
                        {group.courseName || "Curso"}
                      </p>
                      <h3 className="text-lg font-semibold text-slate-900">
                        {group.groupName}
                      </h3>
                      <p className="text-sm text-slate-600">
                        {group.semester || "Sin semestre definido"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        group.status === "active"
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {group.status === "active" ? "Activo" : group.status}
                    </span>
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-slate-700">
                    <div className="flex items-center justify-between">
                      <span>Alumnos</span>
                      <span className="font-semibold text-slate-900">
                        {group.studentsCount} / {group.maxStudents || "∞"}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 transition-all"
                        style={{
                          width: `${group.maxStudents ? Math.min(100, Math.round((group.studentsCount / group.maxStudents) * 100)) : 100}%`,
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>
                        Inicio:{" "}
                        {group.startDate
                          ? group.startDate.toLocaleDateString()
                          : "Sin fecha"}
                      </span>
                      <span>
                        Fin:{" "}
                        {group.endDate ? group.endDate.toLocaleDateString() : "Sin fecha"}
                      </span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Cursos
              </p>
              <h2 className="text-lg font-semibold text-slate-900">Mejor desempeño</h2>
            </div>
            <Link
              href="/creator/cursos"
              className="text-sm font-medium text-blue-700 hover:underline"
            >
              Ver cursos
            </Link>
          </div>

          {loading ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Cargando cursos...
            </div>
          ) : topCourses.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              Aún no has creado cursos. Empieza con el primer curso para ver métricas aquí.
            </div>
          ) : (
            <div className="space-y-3">
              {topCourses.map((course) => (
                <div
                  key={course.id}
                  className="rounded-lg border border-slate-200 p-4 transition hover:border-blue-200"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">
                        {course.title}
                      </h3>
                      <p className="text-sm text-slate-600 line-clamp-2">
                        {course.description || "Sin descripción"}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        course.isPublished
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-amber-100 text-amber-700"
                      }`}
                    >
                      {course.isPublished ? "Publicado" : "Borrador"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm text-slate-700">
                    <span>{course.lessonsCount ?? 0} lecciones</span>
                    <span className="font-semibold text-blue-700">
                      {course.studentsCount ?? 0} alumnos
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-blue-600 transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(5, (course.studentsCount ?? 0) * 4),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="col-span-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Cupos
              </p>
              <h2 className="text-lg font-semibold text-slate-900">Ocupación general</h2>
            </div>
            <span className="text-sm font-semibold text-indigo-700">{fillRate}%</span>
          </div>
          <div className="mt-4 h-3 w-full rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-blue-500 to-emerald-400 transition-all"
              style={{ width: `${fillRate}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-700">
            <span>Cupos totales: {totalCapacity || "Define capacidad"}</span>
            <span>Alumnos inscritos: {totalStudents}</span>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-600 via-blue-600 to-indigo-700 p-5 text-white shadow-sm">
          <p className="text-xs uppercase tracking-[0.25em] text-white/80">Próximo hito</p>
          <h2 className="mt-2 text-lg font-semibold">
            {nextStart
              ? `Inicio de ${nextStart.groupName}`
              : "Define la siguiente cohorte"}
          </h2>
          <p className="mt-1 text-sm text-white/80">
            {nextStart
              ? `Inicio el ${nextStart.startDate?.toLocaleDateString() ?? "pronto"}`
              : "Agrega fechas de inicio para coordinar a tus alumnos."}
          </p>
          <Link
            href="/creator/grupos"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-white px-3 py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-slate-100"
          >
            Gestionar cohortes
          </Link>
        </div>
      </section>
    </div>
  );
}

type KpiCardProps = {
  title: string;
  value: string;
  description: string;
  accent: string;
};

function KpiCard({ title, value, description, accent }: KpiCardProps) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-gradient-to-br ${accent} p-4 shadow-sm`}
    >
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{title}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-3xl font-semibold text-slate-900">{value}</span>
        <span className="text-xs font-medium text-blue-700">{description}</span>
      </div>
    </div>
  );
}
