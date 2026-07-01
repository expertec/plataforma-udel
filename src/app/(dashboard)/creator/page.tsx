"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { Course, getCourses } from "@/lib/firebase/courses-service";
import { Group, getAllGroups, getCoordinatorScopeGroups, getGroupsForTeacher } from "@/lib/firebase/groups-service";
import { getUserPlantelAssignments } from "@/lib/firebase/planteles-service";
import {
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  resolveUserRole,
  UserRole,
} from "@/lib/firebase/roles";

export default function CreatorPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setCourses([]);
        setGroups([]);
        setUserRole(null);
        setLoadError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
        const teacherId = isAdminTeacherRole(role) ? undefined : user.uid;
        const isCoordinator = isCampusCoordinatorRole(role);
        const coordinatorPlantelIds = isCoordinator
          ? (await getUserPlantelAssignments(user.uid)).map((assignment) => assignment.plantelId)
          : [];
        // Limitar la carga inicial para reducir lecturas de Firestore
        // Dashboard solo necesita mostrar resumen, no todos los datos
        const DASHBOARD_LIMIT = 20; // Suficiente para estadísticas y preview
        const [coursesData, groupsData] = await Promise.all([
          getCourses(teacherId, DASHBOARD_LIMIT),
          isAdminTeacherRole(role)
            ? getAllGroups(DASHBOARD_LIMIT)
            : isCoordinator
              ? getCoordinatorScopeGroups(coordinatorPlantelIds, user.uid, DASHBOARD_LIMIT)
              : getGroupsForTeacher(user.uid, DASHBOARD_LIMIT),
        ]);
        setCourses(coursesData);
        setGroups(groupsData);
      } catch (err) {
        console.error("No se pudo cargar dashboard profesor:", err);
        setLoadError("No se pudieron cargar tus datos. Revisa tu conexión e intenta de nuevo.");
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
        <p className="text-xs uppercase tracking-[0.3em] text-[#9f6e61]">Dashboard</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold text-[#551b22]">
              Hola, {name}
            </h1>
            <p className="text-sm text-[#754848]">
              Resumen de tu actividad docente, alumnos inscritos y rendimiento de tus cohortes.
            </p>
          </div>
          {isAdminTeacherRole(userRole) || isCampusCoordinatorRole(userRole) ? (
            <Link
              href="/creator/grupos"
              className="inline-flex items-center justify-center rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-2 text-sm font-medium text-[#6e2d2d] shadow-sm transition hover:-translate-y-0.5 hover:border-[#8a1f28] hover:text-[#551b22]"
            >
              + Crear nuevo grupo
            </Link>
          ) : null}
        </div>
      </header>
      {loadError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 shadow-sm">
          {loadError}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Cursos"
          value={courses.length.toString()}
          description={`${publishedCourses} publicados`}
          variant="brand"
        />
        <KpiCard
          title="Grupos activos"
          value={activeGroups.toString()}
          description={`${groups.length} en total`}
          variant="neutral"
        />
        <KpiCard
          title="Alumnos inscritos"
          value={totalStudents.toString()}
          description={
            totalCapacity > 0
              ? `${Math.max(totalCapacity - totalStudents, 0)} cupos disponibles`
              : "Define cupos en tus grupos"
          }
          variant="neutral"
        />
        <KpiCard
          title="Ocupación promedio"
          value={`${fillRate}%`}
          description={
            totalCapacity > 0
              ? `Sobre ${totalCapacity} cupos`
              : "Añade capacidad a tus grupos"
          }
          variant="neutral"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_1fr]">
        <section className="creator-card space-y-3 rounded-2xl border p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">
                Cohortes
              </p>
              <h2 className="text-lg font-semibold text-[#551b22]">Actividad reciente</h2>
            </div>
            <Link
              href="/creator/grupos"
              className="creator-accent-link text-sm font-medium hover:underline"
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
                <article key={group.id} className="creator-card rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-[#9f6e61]">
                        {group.courseName || "Curso"}
                      </p>
                      <h3 className="text-lg font-semibold text-[#551b22]">
                        {group.groupName}
                      </h3>
                      <p className="text-sm text-[#754848]">
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
                  <div className="mt-3 space-y-2 text-sm text-[#754848]">
                    <div className="flex items-center justify-between">
                      <span>Alumnos</span>
                      <span className="font-semibold text-[#551b22]">
                        {group.studentsCount} / {group.maxStudents || "∞"}
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-[#ecd6cd]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#8a1f28] via-[#6e2d2d] to-[#551b22] transition-all"
                        style={{
                          width: `${group.maxStudents ? Math.min(100, Math.round((group.studentsCount / group.maxStudents) * 100)) : 100}%`,
                        }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-xs text-[#9f6e61]">
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

        <section className="creator-card space-y-4 rounded-2xl border p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">
                Cursos
              </p>
              <h2 className="text-lg font-semibold text-[#551b22]">Mejor desempeño</h2>
            </div>
            <Link
              href="/creator/cursos"
              className="creator-accent-link text-sm font-medium hover:underline"
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
                  className="creator-card rounded-lg border p-4 transition hover:-translate-y-0.5"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-[#551b22]">
                        {course.title}
                      </h3>
                      <p className="line-clamp-2 text-sm text-[#754848]">
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
                  <div className="mt-3 flex items-center justify-between text-sm text-[#754848]">
                    <span>{course.lessonsCount ?? 0} lecciones</span>
                    <span className="font-semibold text-[#6e2d2d]">
                      {course.studentsCount ?? 0} alumnos
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full rounded-full bg-[#ecd6cd]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#8a1f28] via-[#6e2d2d] to-[#551b22] transition-all"
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
        <div className="creator-card col-span-2 rounded-2xl border p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">
                Cupos
              </p>
              <h2 className="text-lg font-semibold text-[#551b22]">Ocupación general</h2>
            </div>
            <span className="text-sm font-semibold text-[#6e2d2d]">{fillRate}%</span>
          </div>
          <div className="mt-4 h-3 w-full rounded-full bg-[#ecd6cd]">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#551b22] via-[#8a1f28] to-[#6e2d2d] transition-all"
              style={{ width: `${fillRate}%` }}
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-[#754848]">
            <span>Cupos totales: {totalCapacity || "Define capacidad"}</span>
            <span>Alumnos inscritos: {totalStudents}</span>
          </div>
        </div>
        <div className="creator-kpi-brand rounded-2xl border p-5 text-white shadow-sm">
          <p className="text-xs uppercase tracking-[0.25em] text-white/70">Próximo hito</p>
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
            className="mt-4 inline-flex items-center justify-center rounded-xl bg-white px-3 py-2 text-sm font-semibold text-[#6e2d2d] shadow-sm transition hover:bg-[#fff7f7]"
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
  variant: "brand" | "neutral";
};

function KpiCard({ title, value, description, variant }: KpiCardProps) {
  const cardClass =
    variant === "brand"
      ? "creator-kpi-brand text-white"
      : "creator-kpi text-[#551b22]";
  const eyebrowClass =
    variant === "brand" ? "text-white/70" : "text-[#9f6e61]";
  const valueClass = variant === "brand" ? "text-white" : "text-[#551b22]";
  const descriptionClass = variant === "brand" ? "text-white/80" : "text-[#6e2d2d]";

  return (
    <div className={`${cardClass} rounded-2xl border p-4 shadow-sm`}>
      <p className={`text-xs uppercase tracking-[0.2em] ${eyebrowClass}`}>{title}</p>
      <div className="mt-2 flex items-end justify-between gap-2">
        <span className={`text-3xl font-semibold ${valueClass}`}>{value}</span>
        <span className={`text-xs font-medium ${descriptionClass}`}>{description}</span>
      </div>
    </div>
  );
}
