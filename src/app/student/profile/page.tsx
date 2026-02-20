"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, signOut, updatePassword, User } from "firebase/auth";
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getStudentSubmissions, Submission } from "@/lib/firebase/submissions-service";

type TaskItem = {
  id: string;
  title: string;
  course?: string;
  lesson?: string;
  status?: string;
  grade?: number;
  submittedAt?: string;
  feedback?: string;
};

type StudyRouteWeek = {
  lesson: string;
  status: string;
  gradeLabel: string;
  activitiesCount: number;
  lastSubmittedAt?: string;
  lastSubmittedAtTs?: number;
};

type StudyRouteCourse = {
  courseId?: string;
  course: string;
  isClosed?: boolean;
  finalGradeLabel?: string;
  closedAt?: string;
  closedAtTs?: number;
  weeks: StudyRouteWeek[];
};

export default function StudentProfilePage() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [name, setName] = useState(auth.currentUser?.displayName ?? "");
  const [email, setEmail] = useState(auth.currentUser?.email ?? "");
  const [phone, setPhone] = useState("");
  const [degree, setDegree] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [programCourses, setProgramCourses] = useState<{ id: string; title: string; coverUrl?: string }[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [studyRoute, setStudyRoute] = useState<StudyRouteCourse[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [expandedFeedback, setExpandedFeedback] = useState<Set<string>>(new Set());

  const coursesForMap = useMemo(() => {
    if (programCourses.length) return programCourses;
    const unique = Array.from(new Set(tasks.map((t) => t.course || "Curso"))).map((title, idx) => ({
      id: `fallback-${idx}`,
      title: title || "Curso",
      coverUrl: "",
    }));
    return unique;
  }, [programCourses, tasks]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (usr) => {
      setUser(usr);
      setName(usr?.displayName ?? "");
      setEmail(usr?.email ?? "");
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchProfile = async () => {
      if (!user?.uid) return;
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (!snap.exists()) return;
        const d = snap.data();
        if (cancelled) return;
        setName((prev) => prev || (d.displayName ?? d.name ?? ""));
        setEmail((prev) => prev || (d.email ?? ""));
        setPhone(d.phone ?? "");
        setDegree(d.program ?? d.degree ?? "");
      } catch (err) {
        console.error("No se pudo cargar el perfil de usuario:", err);
      }
    };
    fetchProfile();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  useEffect(() => {
    let cancelled = false;
    const fetchProgramCourses = async () => {
      if (!degree) {
        setProgramCourses([]);
        return;
      }
      const degreeValue = degree.trim();
      const fields = ["program", "category", "programName"];
      const collected: { id: string; title: string; coverUrl?: string }[] = [];
      try {
        for (const field of fields) {
          const snap = await getDocs(
            query(collection(db, "courses"), where(field, "==", degreeValue))
          );
          if (snap.empty) continue;
          snap.docs.forEach((d) => {
            const data = d.data();
            const cover =
              data.coverUrl ||
              data.cover ||
              data.banner ||
              data.thumbnail ||
              data.image ||
              data.imageUrl ||
              data.hero ||
              "";
            collected.push({
              id: d.id,
              title: data.title ?? "Curso",
              coverUrl: cover,
            });
          });
          if (collected.length) break;
        }
        if (cancelled) return;
        setProgramCourses(collected);
      } catch (err) {
        console.error("No se pudieron cargar los cursos del programa:", err);
        if (!cancelled) setProgramCourses([]);
      }
    };
    fetchProgramCourses();
    return () => {
      cancelled = true;
    };
  }, [degree]);

  useEffect(() => {
    if (!user?.uid) return;
    const loadSubmissions = async () => {
      setLoadingSubs(true);
      try {
        const enrSnap = await getDocs(
          query(
            collection(db, "studentEnrollments"),
            where("studentId", "==", user.uid),
            orderBy("enrolledAt", "desc"),
          ),
        );
        if (enrSnap.empty) {
          setTasks([]);
          setStudyRoute([]);
          setGroupId(null);
          return;
        }

        const enrollmentGroupIds = Array.from(
          new Set(
            enrSnap.docs
              .map((d) => d.data().groupId as string | undefined)
              .filter((gid): gid is string => Boolean(gid)),
          ),
        );
        setGroupId(enrollmentGroupIds[0] ?? null);

        const toClosureDate = (value: unknown): Date | null => {
          if (!value) return null;
          if (value instanceof Date) return value;
          if (typeof value === "object" && value !== null && "toDate" in value) {
            const fn = (value as { toDate?: () => Date }).toDate;
            if (typeof fn === "function") {
              try {
                return fn();
              } catch {
                return null;
              }
            }
          }
          return null;
        };

        const closedCourseMap = new Map<
          string,
          { finalGrade: number | null; closedAtTs: number; closedAt?: string }
        >();
        enrSnap.docs.forEach((docSnap) => {
          const data = docSnap.data() as { courseClosures?: Record<string, unknown> };
          const closures = (data.courseClosures ?? {}) as Record<string, unknown>;
          Object.entries(closures).forEach(([courseId, closureRaw]) => {
            const normalizedCourseId = courseId.trim();
            if (!normalizedCourseId) return;
            if (!closureRaw || typeof closureRaw !== "object") return;
            const closure = closureRaw as Record<string, unknown>;
            if (closure.status !== "closed") return;

            const closedAtDate =
              toClosureDate(closure.closedAt) ??
              toClosureDate(closure.updatedAt) ??
              toClosureDate(closure.reopenedAt);
            const closedAtTs = closedAtDate?.getTime() ?? 0;
            const existing = closedCourseMap.get(normalizedCourseId);
            if (existing && existing.closedAtTs > closedAtTs) return;

            closedCourseMap.set(normalizedCourseId, {
              finalGrade:
                typeof closure.finalGrade === "number" && Number.isFinite(closure.finalGrade)
                  ? closure.finalGrade
                  : null,
              closedAtTs,
              closedAt:
                closedAtDate ? new Intl.DateTimeFormat("es-MX").format(closedAtDate) : undefined,
            });
          });
        });

        if (!enrollmentGroupIds.length) {
          setTasks([]);
          setStudyRoute([]);
          return;
        }

        const submissionsByGroup = await Promise.all(
          enrollmentGroupIds.map(async (gid) => {
            try {
              const submissions = await getStudentSubmissions(gid, user.uid);
              return submissions.map((sub) => ({ ...sub, groupId: gid }));
            } catch (err) {
              console.warn(`No se pudieron cargar entregas del grupo ${gid}:`, err);
              return [];
            }
          }),
        );

        const allSubmissions: Array<Submission & { groupId: string }> = submissionsByGroup.flat();
        const courseCache = new Map<
          string,
          {
            lessonTitles: Map<string, string>;
            classToLesson: Map<string, { lessonId: string; lessonTitle: string }>;
          }
        >();

        const loadCourseIndex = async (courseId: string) => {
          if (courseCache.has(courseId)) return courseCache.get(courseId)!;
          const lessonTitles = new Map<string, string>();
          const classToLesson = new Map<string, { lessonId: string; lessonTitle: string }>();

          try {
            const lessonsSnap = await getDocs(
              query(collection(db, "courses", courseId, "lessons"), orderBy("order", "asc")),
            );
            for (const lessonDoc of lessonsSnap.docs) {
              const lessonData = lessonDoc.data() as { title?: string };
              const lessonTitle = (lessonData.title ?? "Semana").trim() || "Semana";
              lessonTitles.set(lessonDoc.id, lessonTitle);

              const classesSnap = await getDocs(
                collection(db, "courses", courseId, "lessons", lessonDoc.id, "classes"),
              );
              classesSnap.docs.forEach((classDoc) => {
                classToLesson.set(classDoc.id, {
                  lessonId: lessonDoc.id,
                  lessonTitle,
                });
              });
            }
          } catch (err) {
            console.warn(`No se pudo indexar el curso ${courseId}:`, err);
          }

          const index = { lessonTitles, classToLesson };
          courseCache.set(courseId, index);
          return index;
        };

        const uniqueCourseIds = Array.from(
          new Set(
            allSubmissions
              .map((submission) => (submission.courseId ?? "").trim())
              .filter((courseId): courseId is string => courseId.length > 0),
          ),
        );
        await Promise.all(uniqueCourseIds.map((courseId) => loadCourseIndex(courseId)));

        const resolveLessonLabel = async (submission: Submission) => {
          const directTitle = (submission.lessonTitle ?? "").trim();
          if (directTitle) return directTitle;

          const courseId = (submission.courseId ?? "").trim();
          if (!courseId) return "Semana sin identificar";

          const courseIndex = await loadCourseIndex(courseId);
          const directLessonId = (submission.lessonId ?? "").trim();
          if (directLessonId) {
            const byLessonId = courseIndex.lessonTitles.get(directLessonId);
            if (byLessonId) return byLessonId;
          }

          const byClass = courseIndex.classToLesson.get(submission.classDocId ?? submission.classId);
          if (byClass?.lessonTitle) return byClass.lessonTitle;
          return "Semana sin identificar";
        };

        const normalizedSubmissions = await Promise.all(
          allSubmissions.map(async (submission) => ({
            ...submission,
            resolvedLesson: await resolveLessonLabel(submission),
          })),
        );

        const ordered = normalizedSubmissions.sort((a, b) => {
          const at = a.submittedAt?.getTime?.() ?? 0;
          const bt = b.submittedAt?.getTime?.() ?? 0;
          return bt - at;
        });

        setTasks(
          ordered.map((s) => ({
            id: `${s.groupId}:${s.id}`,
            title: s.className || "Entrega",
            course: s.courseTitle ?? "",
            lesson: s.resolvedLesson ?? "",
            status: s.status === "graded" ? "Calificado" : s.status === "late" ? "Fuera de tiempo" : "En revisión",
            grade: s.grade,
            submittedAt: s.submittedAt ? new Intl.DateTimeFormat("es-MX").format(s.submittedAt) : undefined,
            feedback: s.feedback ?? "",
          })),
        );
        const routeByCourse = new Map<
          string,
          {
            course: string;
            courseId: string;
            weeksMap: Map<string, Array<{ grade?: number; submittedAt?: Date | null }>>;
          }
        >();
        ordered.forEach((s) => {
          const courseId = (s.courseId ?? "").trim();
          const courseLabel = (s.courseTitle ?? "Curso").trim() || "Curso";
          const courseKey = `${courseId || "sin-curso"}::${courseLabel}`;
          const lessonLabel = (s.resolvedLesson ?? "Semana sin identificar").trim() || "Semana sin identificar";
          if (!routeByCourse.has(courseKey)) {
            routeByCourse.set(courseKey, {
              course: courseLabel,
              courseId,
              weeksMap: new Map(),
            });
          }
          const weeks = routeByCourse.get(courseKey)!.weeksMap;
          if (!weeks.has(lessonLabel)) {
            weeks.set(lessonLabel, []);
          }
          weeks.get(lessonLabel)!.push({
            grade: s.grade,
            submittedAt: s.submittedAt,
          });
        });

        const route: StudyRouteCourse[] = Array.from(routeByCourse.values())
          .map((courseEntry) => {
            const closureInfo = courseEntry.courseId
              ? closedCourseMap.get(courseEntry.courseId)
              : undefined;
            const isClosed = Boolean(closureInfo);
            const weeks = Array.from(courseEntry.weeksMap.entries())
              .map(([lesson, items]) => {
                const graded = items.filter((i) => typeof i.grade === "number");
                const avgGrade =
                  graded.length > 0
                    ? graded.reduce((acc, item) => acc + (item.grade ?? 0), 0) / graded.length
                    : null;
                const pendingCount = items.length - graded.length;
                const lastTimestamp = items.reduce(
                  (acc, item) => Math.max(acc, item.submittedAt?.getTime?.() ?? 0),
                  0,
                );
                return {
                  lesson,
                  status:
                    pendingCount === 0
                      ? "Calificada"
                      : graded.length > 0
                        ? "Parcial"
                        : "En revisión",
                  gradeLabel: avgGrade === null ? "—" : avgGrade.toFixed(1),
                  activitiesCount: items.length,
                  lastSubmittedAtTs: lastTimestamp,
                  lastSubmittedAt:
                    lastTimestamp > 0
                      ? new Intl.DateTimeFormat("es-MX").format(new Date(lastTimestamp))
                      : undefined,
                };
              })
              .sort((a, b) => (b.lastSubmittedAtTs ?? 0) - (a.lastSubmittedAtTs ?? 0));

            return {
              courseId: courseEntry.courseId || undefined,
              course: courseEntry.course,
              isClosed,
              finalGradeLabel:
                isClosed && typeof closureInfo?.finalGrade === "number"
                  ? closureInfo.finalGrade.toFixed(1)
                  : undefined,
              closedAt: isClosed ? closureInfo?.closedAt : undefined,
              closedAtTs: isClosed ? closureInfo?.closedAtTs : undefined,
              weeks,
            };
          })
          .sort((a, b) => a.course.localeCompare(b.course));

        setStudyRoute(route);
      } catch (err) {
        console.error("No se pudieron cargar las entregas:", err);
        toast.error("No se pudieron cargar tus entregas");
        setTasks([]);
        setStudyRoute([]);
        setGroupId(null);
      } finally {
        setLoadingSubs(false);
      }
    };
    loadSubmissions();
  }, [user?.uid]);

  const handleSave = () => {
    // Aquí se guardaría en Firestore el perfil; por ahora solo avisamos.
    toast.success("Perfil actualizado");
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      toast.success("Sesión cerrada");
      window.location.href = "/";
    } catch (err) {
      console.error("Error al cerrar sesión:", err);
      toast.error("No se pudo cerrar sesión");
    }
  };

  const handleChangePassword = async () => {
    if (!user) {
      toast.error("Inicia sesión para cambiar la contraseña.");
      return;
    }
    if (newPassword.length < 6) {
      toast.error("La contraseña debe tener al menos 6 caracteres.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Las contraseñas no coinciden.");
      return;
    }
    setChangingPassword(true);
    try {
      await updatePassword(user, newPassword);
      toast.success("Contraseña actualizada");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      console.error("No se pudo actualizar la contraseña:", err);
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/requires-recent-login") {
        toast.error("Vuelve a iniciar sesión y prueba de nuevo.");
      } else {
        toast.error("No se pudo cambiar la contraseña");
      }
    } finally {
      setChangingPassword(false);
    }
  };

  const tabs: { key: "perfil" | "plan" | "seguridad"; label: string }[] = [
    { key: "perfil", label: "Perfil" },
    { key: "plan", label: "Plan de estudio" },
    { key: "seguridad", label: "Seguridad" },
  ];
  const [activeTab, setActiveTab] = useState<"perfil" | "plan" | "seguridad">("perfil");

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-neutral-900/80 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-lg font-bold text-white">
            {(name || email || "UD").slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-white/60">Perfil de alumno</p>
            <h1 className="text-lg font-semibold leading-tight">UDEL Universidad</h1>
          </div>
        </div>
        <Link
          href="/student"
          className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-white/20"
        >
          ⟵ Volver al feed
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6">
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === tab.key
                  ? "bg-white text-neutral-900 shadow"
                  : "border border-white/20 text-white hover:bg-white/10"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "perfil" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-lg font-bold text-white">
                    {(name || email || "UD").slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-white/60">Estudiante</p>
                    <h2 className="text-xl font-semibold text-white">{name || "Tu nombre"}</h2>
                    <p className="text-sm text-white/60">{email || "correo@institucional.com"}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                    {user ? "Sesión activa" : "Inicia sesión"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingProfile((prev) => !prev)}
                    className="rounded-full border border-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/10"
                  >
                    {editingProfile ? "Ver vista" : "Editar perfil"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("seguridad")}
                    className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-blue-500"
                  >
                    Ir a seguridad
                  </button>
                </div>
              </div>

              {!editingProfile ? (
                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <ProfileField label="Nombre completo" value={name || "Agrega tu nombre"} />
                  <ProfileField label="Correo institucional" value={email || "—"} />
                  <ProfileField label="Teléfono" value={phone || "No registrado"} />
                  <ProfileField label="Programa" value={degree || "Sin programa"} />
                </div>
              ) : (
                <>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label className="space-y-1 text-sm text-white/80">
                      <span>Nombre completo</span>
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1 text-sm text-white/80">
                      <span>Correo institucional</span>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                        disabled
                      />
                    </label>
                    <label className="space-y-1 text-sm text-white/80">
                      <span>Teléfono</span>
                      <input
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                      />
                    </label>
                    <label className="space-y-1 text-sm text-white/80">
                      <span>Programa</span>
                      <input
                        value={degree}
                        onChange={(e) => setDegree(e.target.value)}
                        className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                      />
                    </label>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        handleSave();
                        setEditingProfile(false);
                      }}
                      className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-500"
                      disabled={!user}
                    >
                      Guardar cambios
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setName(user?.displayName ?? "");
                        setEmail(user?.email ?? "");
                        setPhone("");
                        setDegree("");
                        toast("Datos restablecidos", { icon: "↺" });
                      }}
                      className="inline-flex items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
                    >
                      Restablecer
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingProfile(false);
                      }}
                      className="inline-flex items-center justify-center rounded-full bg-neutral-800 px-4 py-2 text-sm font-semibold text-white border border-white/15 hover:bg-neutral-700"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="inline-flex items-center justify-center rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-red-500"
                    >
                      Cerrar sesión
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        ) : null}

        {activeTab === "plan" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.16em] text-white/60">Plan de estudio</p>
                  <h3 className="text-xl font-semibold text-white">{degree || "Sin programa asignado"}</h3>
                  <p className="text-sm text-white/70">
                    Tu programa y las materias asociadas que has visto en tus entregas.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("seguridad")}
                    className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-blue-500"
                  >
                    Seguridad
                  </button>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.14em] text-white/50">Programa</p>
                  <p className="mt-1 text-lg font-semibold text-white">
                    {degree || "Aún no asignado"}
                  </p>
                  <p className="text-xs text-white/60 mt-1">
                    Si no ves tu programa, contácta a tu coordinador para asignarlo.
                  </p>
                  {degree ? (
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => setMapOpen(true)}
                        className="rounded-full border border-blue-300/40 bg-blue-500/15 px-3 py-1 text-xs font-semibold text-blue-100 hover:bg-blue-500/25"
                      >
                        Ver mapa
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="rounded-xl border border-white/10 bg-white/5 p-4">
                  <p className="text-xs uppercase tracking-[0.14em] text-white/50">Estado</p>
                  <p className="mt-1 inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-semibold text-emerald-100">
                    Activo
                  </p>
                  <p className="text-xs text-white/60 mt-1">
                    Última sincronización: {tasks.length ? "reciente" : "sin datos"}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <StatCard label="Clases completadas" value="-" hint="Sin datos aún" />
                <StatCard label="Tareas entregadas" value={tasks.length ? tasks.length.toString() : "-"} hint="Últimas entregas" />
                <StatCard label="Promedio general" value="-" hint="En cálculo" />
                <StatCard label="Asistencia" value="-" hint="Sin datos aún" />
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">Ruta de materias cursadas</p>
                  <span className="text-xs text-white/60">
                    {studyRoute.length ? `${studyRoute.length} materias` : "Sin materias registradas"}
                  </span>
                </div>
                {studyRoute.length === 0 ? (
                  <p className="mt-2 text-sm text-white/70">
                    Aún no hay avance histórico disponible. Revisa más tarde.
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {studyRoute.map((course) => (
                      <div
                        key={`${course.courseId ?? "sin-curso"}::${course.course}`}
                        className="rounded-xl border border-white/10 bg-neutral-900/60 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-white">{course.course || "Curso"}</p>
                            {course.isClosed ? (
                              <p className="mt-1 text-[11px] text-emerald-200">
                                Materia cerrada
                                {course.closedAt ? ` • ${course.closedAt}` : ""}
                              </p>
                            ) : (
                              <p className="mt-1 text-[11px] text-white/55">Materia abierta</p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            {course.isClosed && course.finalGradeLabel ? (
                              <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-semibold text-emerald-100">
                                Final: {course.finalGradeLabel}
                              </span>
                            ) : null}
                            <span className="text-[11px] text-white/60">{course.weeks.length} semanas</span>
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          {course.weeks.map((week) => (
                            <div
                              key={`${course.course}-${week.lesson}`}
                              className="rounded-lg border border-white/10 bg-black/30 px-3 py-2"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-xs font-semibold text-white">{week.lesson}</p>
                                <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-[11px] font-semibold text-emerald-100">
                                  {week.gradeLabel}
                                </span>
                              </div>
                              <p className="mt-1 text-[11px] text-white/70">
                                {week.status} • {week.activitiesCount} actividades
                              </p>
                              {week.lastSubmittedAt ? (
                                <p className="text-[10px] text-white/50">Última entrega: {week.lastSubmittedAt}</p>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">Tareas y entregas</h3>
                  <span className="text-xs text-white/70">
                    {groupId ? "Estado de tus entregas" : "Sin grupo asignado"}
                  </span>
                </div>
                {loadingSubs ? (
                  <p className="text-sm text-white/70">Cargando entregas...</p>
                ) : tasks.length === 0 ? (
                  <p className="text-sm text-white/70">No hay tareas registradas todavía.</p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {tasks.map((task) => (
                      <div key={task.id} className="rounded-xl border border-white/5 bg-neutral-900/60 p-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm font-semibold">{task.title}</p>
                          <span
                            className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                              task.status === "Calificado"
                                ? "bg-emerald-500/20 text-emerald-100"
                                : task.status === "Fuera de tiempo"
                                  ? "bg-red-500/20 text-red-100"
                                  : "bg-amber-500/20 text-amber-100"
                            }`}
                          >
                            {task.status ?? "Sin estado"}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-white/70">
                          {task.course ? `${task.course}` : "Curso no disponible"}
                        </p>
                        {task.lesson ? (
                          <p className="text-xs text-white/60">
                            {task.lesson}
                          </p>
                        ) : null}
                        <p className="text-xs text-white/60">
                          {task.submittedAt ? `Enviado: ${task.submittedAt}` : "Fecha de envío no disponible"}
                        </p>
                        {typeof task.grade === "number" ? (
                          <p className="mt-1 text-sm font-semibold text-white">Calificación: {task.grade}</p>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-[11px] uppercase tracking-[0.12em] text-white/50">
                            Retroalimentación
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setExpandedFeedback((prev) => {
                                const next = new Set(prev);
                                if (next.has(task.id)) {
                                  next.delete(task.id);
                                } else {
                                  next.add(task.id);
                                }
                                return next;
                              });
                            }}
                            className="text-xs font-semibold text-emerald-200 hover:text-emerald-100"
                          >
                            {expandedFeedback.has(task.id) ? "Ocultar" : "Ver"}
                          </button>
                        </div>
                        {expandedFeedback.has(task.id) ? (
                          <div className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2">
                            <p className="text-xs text-white/80 whitespace-pre-wrap">
                              {task.feedback?.trim() ? task.feedback : "No hay retroalimentación registrada."}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {activeTab === "seguridad" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Cambiar contraseña</h2>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                  {user ? "Seguro" : "Inicia sesión"}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm text-white/80">
                  <span>Nueva contraseña</span>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Mínimo 6 caracteres"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                  />
                </label>
                <label className="space-y-1 text-sm text-white/80">
                  <span>Confirmar contraseña</span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Reingresa la contraseña"
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/30 focus:outline-none"
                  />
                </label>
              </div>
              <p className="mt-3 text-xs text-white/60">
                Actualizar la contraseña requiere haber iniciado sesión recientemente. Si recibes un error,
                cierra sesión y vuelve a iniciar sesión antes de intentarlo otra vez.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={handleChangePassword}
                  className="inline-flex items-center justify-center rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={!user || changingPassword}
                >
                  {changingPassword ? "Actualizando..." : "Cambiar contraseña"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNewPassword("");
                    setConfirmPassword("");
                  }}
                  className="inline-flex items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
                >
                  Limpiar campos
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </main>

      {mapOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur">
          <div className="relative h-[92vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-b from-neutral-900 via-neutral-950 to-neutral-900 shadow-2xl">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.08),transparent_45%),radial-gradient(circle_at_20%_30%,rgba(255,255,255,0.05),transparent_30%),radial-gradient(circle_at_80%_40%,rgba(255,255,255,0.04),transparent_30%)]" />
            <div className="relative flex items-center justify-between px-4 py-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-white/60">Mapa de programa</p>
                <h3 className="text-lg font-semibold text-white">{degree || "Programa"}</h3>
                <p className="text-xs text-white/60">Ruta visual de tus cursos asignados</p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMapOpen(false)}
                  className="rounded-full border border-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/10"
                >
                  Cerrar
                </button>
              </div>
            </div>
            <div className="relative h-full overflow-y-auto px-6 pb-10">
              <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 py-4">
                {coursesForMap.length === 0 ? (
                  <p className="text-sm text-white/70">No hay cursos asignados al programa todavía.</p>
                ) : (
                  coursesForMap.map((course, idx) => (
                    <div key={course.id} className="flex w-full flex-col items-center gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xl font-black text-white/30">{idx + 1}</span>
                        <div className="h-2 w-2 rounded-full border border-blue-300 bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.2)]" />
                      </div>
                      <div className="w-full rounded-2xl border border-white/10 bg-white/5 p-3 shadow-xl">
                        <p className="text-sm font-semibold text-white">{course.title}</p>
                        <p className="text-xs text-white/60">Parte {idx + 1} del programa</p>
                        {course.coverUrl ? (
                          <img
                            src={course.coverUrl}
                            alt={course.title}
                            className="mt-3 h-40 w-full rounded-xl object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="mt-3 flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/5 text-xs text-white/40">
                            Sin portada
                          </div>
                        )}
                      </div>
                      {idx < coursesForMap.length - 1 ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <div className="h-4 w-px bg-white/12" />
                          <div className="h-4 w-px bg-white/12" />
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/5 px-3 py-3">
      <p className="text-xs uppercase tracking-[0.12em] text-white/60">{label}</p>
      <p className="text-xl font-semibold text-white">{value}</p>
      {hint ? <p className="text-xs text-white/60">{hint}</p> : null}
    </div>
  );
}

function ProfileField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-3">
      <p className="text-xs uppercase tracking-[0.14em] text-white/50">{label}</p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}
