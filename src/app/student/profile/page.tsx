"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, signOut, updatePassword, User } from "firebase/auth";
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getStudentSubmissions, Submission } from "@/lib/firebase/submissions-service";

type GradeItem = {
  course: string;
  lesson: string;
  grade: string;
  status?: string;
};

type TaskItem = {
  id: string;
  title: string;
  course?: string;
  status?: string;
  grade?: number;
  submittedAt?: string;
  feedback?: string;
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
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [expandedFeedback, setExpandedFeedback] = useState<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (usr) => {
      setUser(usr);
      setName(usr?.displayName ?? "");
      setEmail(usr?.email ?? "");
    });
    return () => unsubscribe();
  }, []);

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
            limit(1),
          ),
        );
        if (enrSnap.empty) {
          setTasks([]);
          setGrades([]);
          setGroupId(null);
          return;
        }
        const enrollment = enrSnap.docs[0].data();
        const gid = enrollment.groupId as string | undefined;
        setGroupId(gid ?? null);
        if (!gid) {
          setTasks([]);
          setGrades([]);
          return;
        }
        const submissions: Submission[] = await getStudentSubmissions(gid, user.uid);
        const ordered = submissions.sort((a, b) => {
          const at = a.submittedAt?.getTime?.() ?? 0;
          const bt = b.submittedAt?.getTime?.() ?? 0;
          return bt - at;
        });
        setTasks(
          ordered.map((s) => ({
            id: s.id,
            title: s.className || "Entrega",
            course: s.courseTitle ?? "",
            status: s.status === "graded" ? "Calificado" : s.status === "late" ? "Fuera de tiempo" : "En revisión",
            grade: s.grade,
            submittedAt: s.submittedAt ? new Intl.DateTimeFormat("es-MX").format(s.submittedAt) : undefined,
            feedback: s.feedback ?? "",
          })),
        );
        setGrades(
          ordered
            .filter((s) => typeof s.grade === "number")
            .map((s) => ({
              course: s.courseTitle ?? "Curso",
              lesson: s.className ?? "Clase",
              grade: (s.grade ?? "").toString(),
              status: s.status === "graded" ? "Calificado" : s.status,
            })),
        );
      } catch (err) {
        console.error("No se pudieron cargar las entregas:", err);
        toast.error("No se pudieron cargar tus entregas");
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

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
        <section className="grid gap-6 lg:grid-cols-[1.4fr,1fr]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Información personal</h2>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                  {user ? "Editable" : "Inicia sesión para editar"}
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
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
                onClick={handleSave}
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
                onClick={handleSignOut}
                className="inline-flex items-center justify-center rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-red-500"
              >
                Cerrar sesión
              </button>
            </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Cambiar contraseña</h2>
                <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                  {user ? "Seguro" : "Inicia sesión"}
                </span>
              </div>
              <div className="space-y-3">
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
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <h3 className="text-base font-semibold text-white">Estado general</h3>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <StatCard label="Clases completadas" value="-" hint="Sin datos aún" />
                <StatCard label="Tareas entregadas" value="-" hint="Sin datos aún" />
                <StatCard label="Promedio general" value="-" hint="Sin datos aún" />
                <StatCard label="Asistencia" value="-" hint="Sin datos aún" />
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
              <h3 className="text-base font-semibold text-white">Calificaciones</h3>
              {grades.length === 0 ? (
                <p className="mt-3 text-sm text-white/70">Aún no hay calificaciones disponibles.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {grades.map((item) => (
                    <div
                      key={`${item.course}-${item.lesson}`}
                      className="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-3"
                    >
                      <div>
                        <p className="text-sm font-semibold">{item.course}</p>
                        <p className="text-xs text-white/70">{item.lesson}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-bold">{item.grade}</span>
                        <p className="text-xs text-white/70">{item.status ?? ""}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/10 bg-neutral-900/70 p-5 shadow-lg">
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
                <div key={task.id} className="rounded-xl border border-white/5 bg-white/5 p-4">
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
        </section>
      </main>
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
