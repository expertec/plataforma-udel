"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { signOut, updatePassword } from "firebase/auth";
import toast from "react-hot-toast";
import {
  BookOpen,
  Check,
  ClipboardList,
  GraduationCap,
  Loader2,
  LogOut,
  Pencil,
  ShieldCheck,
  Star,
  TrendingUp,
  X,
} from "lucide-react";
import { auth } from "@/lib/firebase/client";
import type { Submission } from "@/lib/firebase/submissions-service";
import { useAulaData } from "../_lib/AulaDataContext";
import {
  formatDate,
  isGraded,
  loadAllSubmissions,
  loadStudentProfile,
  updateStudentDisplayName,
  type StudentProfile,
} from "../_lib/profile";
import { kardexAverage, loadKardex, type KardexRow } from "../_lib/kardex";
import { KardexTable } from "../_components/KardexTable";

type TabId = "materias" | "kardex" | "tareas" | "cuenta";

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof BookOpen;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-3 sm:p-5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--aula-accent)]/15 text-[var(--aula-accent-soft)] sm:h-9 sm:w-9">
        <Icon size={18} />
      </div>
      <p className="mt-2 text-xl font-semibold text-[var(--aula-text)] sm:mt-3 sm:text-2xl">
        {value}
      </p>
      <p className="text-xs text-[var(--aula-text-muted)] sm:text-sm">{label}</p>
      {hint && <p className="mt-1 text-xs text-[var(--aula-text-muted)]">{hint}</p>}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-[var(--aula-border)] px-3 py-1 text-xs text-[var(--aula-text-muted)]">
      {children}
    </span>
  );
}

export default function ProfilePage() {
  const { currentUser, classes, curriculum, isComplete, courseCovers, courseTitles } = useAulaData();

  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(true);
  const [kardex, setKardex] = useState<KardexRow[]>([]);
  const [loadingKardex, setLoadingKardex] = useState(true);
  const [activeTab, setActiveTab] = useState<TabId>("materias");

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const groupIds = useMemo(
    () => Array.from(new Set(classes.map((cls) => cls.groupId).filter(Boolean) as string[])),
    [classes],
  );

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    void loadStudentProfile(currentUser).then((loaded) => {
      if (!cancelled) setProfile(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || groupIds.length === 0) {
      setLoadingSubmissions(false);
      return;
    }
    let cancelled = false;
    setLoadingSubmissions(true);
    void loadAllSubmissions(groupIds, currentUser.uid)
      .then((loaded) => {
        if (!cancelled) setSubmissions(loaded);
      })
      .finally(() => {
        if (!cancelled) setLoadingSubmissions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser, groupIds]);

  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    setLoadingKardex(true);
    void loadKardex(currentUser.uid, courseTitles)
      .then((rows) => {
        if (!cancelled) setKardex(rows);
      })
      .finally(() => {
        if (!cancelled) setLoadingKardex(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUser, courseTitles]);

  const completedCount = useMemo(
    () => classes.filter((cls) => isComplete(cls)).length,
    [classes, isComplete],
  );

  const generalAverage = useMemo(() => kardexAverage(kardex), [kardex]);
  const closedCount = kardex.filter((row) => row.status === "closed").length;

  const overallPct = classes.length === 0 ? 0 : Math.round((completedCount / classes.length) * 100);

  const gradedSubmissions = submissions.filter(isGraded);

  const startEditingName = useCallback(() => {
    setNameDraft(profile?.displayName ?? "");
    setEditingName(true);
  }, [profile?.displayName]);

  const handleSaveName = async () => {
    if (!currentUser) return;
    setSavingName(true);
    try {
      const saved = await updateStudentDisplayName(currentUser, nameDraft);
      setProfile((prev) => (prev ? { ...prev, displayName: saved } : prev));
      setEditingName(false);
      toast.success("Nombre actualizado");
    } catch (err) {
      console.error("No se pudo actualizar el nombre:", err);
      toast.error(err instanceof Error ? err.message : "No se pudo actualizar el nombre");
    } finally {
      setSavingName(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentUser) return;
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
      await updatePassword(currentUser, newPassword);
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Contraseña actualizada");
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "auth/requires-recent-login") {
        toast.error("Por seguridad, vuelve a iniciar sesión y prueba de nuevo.");
      } else {
        console.error("No se pudo actualizar la contraseña:", err);
        toast.error("No se pudo cambiar la contraseña");
      }
    } finally {
      setChangingPassword(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      window.location.href = "/";
    } catch (err) {
      console.error("Error al cerrar sesión:", err);
      toast.error("No se pudo cerrar sesión");
    }
  };

  const initials = (profile?.displayName ?? "E")
    .split(" ")
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "materias", label: "Mis materias" },
    { id: "kardex", label: "Calificaciones" },
    { id: "tareas", label: "Mis tareas" },
    { id: "cuenta", label: "Cuenta" },
  ];

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <section className="flex flex-col gap-5 rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6 sm:flex-row sm:items-center">
        {profile?.photoURL ? (
          <Image
            src={profile.photoURL}
            alt={profile.displayName}
            width={80}
            height={80}
            unoptimized
            className="h-20 w-20 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-[var(--aula-accent)]/20 text-2xl font-semibold text-[var(--aula-accent-soft)]">
            {initials}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {editingName ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                className="flex-1 rounded-lg border border-[var(--aula-border)] bg-[var(--aula-bg)] px-3 py-2 text-lg text-[var(--aula-text)] outline-none focus:border-[var(--aula-accent)]"
              />
              <button
                type="button"
                onClick={handleSaveName}
                disabled={savingName || !nameDraft.trim()}
                className="rounded-lg bg-[var(--aula-accent)] p-2 text-white disabled:opacity-40"
                aria-label="Guardar nombre"
              >
                {savingName ? <Loader2 size={18} className="animate-spin" /> : <Check size={18} />}
              </button>
              <button
                type="button"
                onClick={() => setEditingName(false)}
                className="rounded-lg border border-[var(--aula-border)] p-2 text-[var(--aula-text-muted)]"
                aria-label="Cancelar"
              >
                <X size={18} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="truncate text-2xl font-semibold text-[var(--aula-text)]">
                {profile?.displayName ?? "Estudiante"}
              </h1>
              <button
                type="button"
                onClick={startEditingName}
                className="rounded-lg p-1.5 text-[var(--aula-text-muted)] hover:bg-white/5 hover:text-[var(--aula-text)]"
                aria-label="Editar nombre"
              >
                <Pencil size={16} />
              </button>
            </div>
          )}

          <p className="mt-1 truncate text-sm text-[var(--aula-text-muted)]">{profile?.email}</p>

          <div className="mt-3 flex flex-wrap gap-2">
            {profile?.program && <Chip>{profile.program}</Chip>}
            {profile?.plantelNames.map((name) => (
              <Chip key={name}>{name}</Chip>
            ))}
            {profile?.phone && <Chip>{profile.phone}</Chip>}
          </div>
        </div>
      </section>

      <section className="mt-6 grid grid-cols-3 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label="Avance general"
          value={`${overallPct}%`}
          hint={`${completedCount} de ${classes.length} clases`}
        />
        <StatCard icon={BookOpen} label="Materias activas" value={String(curriculum.length)} />
        <StatCard
          icon={ClipboardList}
          label="Tareas entregadas"
          value={loadingSubmissions ? "…" : String(submissions.length)}
          hint={loadingSubmissions ? undefined : `${gradedSubmissions.length} calificadas`}
        />
        <StatCard
          icon={Star}
          label="Promedio general"
          value={loadingKardex ? "…" : generalAverage === null ? "—" : generalAverage.toFixed(1)}
          hint={
            loadingKardex
              ? undefined
              : generalAverage === null
                ? "Sin materias cerradas"
                : `${closedCount} ${closedCount === 1 ? "materia cerrada" : "materias cerradas"}`
          }
        />
      </section>

      <nav className="mt-8 flex gap-1 border-b border-[var(--aula-border)]">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                active
                  ? "border-[var(--aula-accent)] text-[var(--aula-text)]"
                  : "border-transparent text-[var(--aula-text-muted)] hover:text-[var(--aula-text)]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div className="py-6">
        {activeTab === "materias" && (
          <div className="space-y-4">
            {curriculum.length === 0 ? (
              <p className="text-[var(--aula-text-muted)]">Todavía no tienes materias.</p>
            ) : (
              curriculum.map((course) => {
                const items = course.lessons.flatMap((lesson) => lesson.items);
                const done = items.filter((item) => isComplete(classes[item.index])).length;
                const pct = items.length === 0 ? 0 : Math.round((done / items.length) * 100);
                const cover = courseCovers[course.courseId];

                return (
                  <Link
                    key={course.courseId}
                    href={`/aula/${course.courseId}`}
                    className="flex items-center gap-4 rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-4 transition-colors hover:border-[var(--aula-accent)]"
                  >
                    <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-lg bg-[var(--aula-bg)]">
                      {cover ? (
                        <Image src={cover} alt={course.courseTitle} fill unoptimized className="object-cover" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-[var(--aula-text-muted)]">
                          <GraduationCap size={20} />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-semibold text-[var(--aula-text)]">
                        {course.courseTitle}
                      </h2>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-[var(--aula-accent)]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-[var(--aula-text-muted)]">
                        {done} de {items.length} clases · {pct}%
                      </p>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        )}

        {activeTab === "kardex" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-[var(--aula-text-muted)]">
                Calificaciones finales de tus materias, incluidas las de grupos anteriores.
              </p>
              {generalAverage !== null && (
                <p className="text-sm text-[var(--aula-text-muted)]">
                  Promedio general:{" "}
                  <span className="font-semibold text-[var(--aula-text)]">
                    {generalAverage.toFixed(1)}
                  </span>
                </p>
              )}
            </div>
            <KardexTable rows={kardex} loading={loadingKardex} />
          </div>
        )}

        {activeTab === "tareas" && (
          <div className="space-y-3">
            {loadingSubmissions ? (
              <p className="text-[var(--aula-text-muted)]">Cargando tus entregas…</p>
            ) : submissions.length === 0 ? (
              <p className="text-[var(--aula-text-muted)]">Todavía no has entregado tareas.</p>
            ) : (
              submissions.map((submission) => {
                const graded = isGraded(submission);
                return (
                  <article
                    key={submission.id}
                    className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-medium text-[var(--aula-text)]">{submission.className}</h3>
                        <p className="text-xs text-[var(--aula-text-muted)]">
                          {submission.courseTitle ?? "Materia"} · Entregada el{" "}
                          {formatDate(submission.submittedAt)}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                          graded
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        {graded
                          ? `Calificada${submission.grade !== undefined ? `: ${submission.grade}` : ""}`
                          : "Pendiente de calificar"}
                      </span>
                    </div>

                    {submission.feedback && (
                      <p className="mt-3 rounded-lg bg-[var(--aula-bg)] px-3 py-2 text-sm text-[var(--aula-text-muted)]">
                        <span className="font-medium text-[var(--aula-text)]">
                          Retroalimentación:{" "}
                        </span>
                        {submission.feedback}
                      </p>
                    )}

                    {(submission.fileUrl || submission.audioUrl) && (
                      <a
                        href={submission.fileUrl || submission.audioUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-block text-sm font-medium text-[var(--aula-accent-soft)] hover:underline"
                      >
                        Ver mi entrega
                      </a>
                    )}
                  </article>
                );
              })
            )}
          </div>
        )}

        {activeTab === "cuenta" && (
          <div className="space-y-6">
            <section className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
              <h2 className="font-semibold text-[var(--aula-text)]">Datos de tu cuenta</h2>
              <p className="mt-1 text-sm text-[var(--aula-text-muted)]">
                Solo puedes cambiar tu nombre. Para corregir tu correo, teléfono o programa, contacta
                a tu plantel.
              </p>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                {[
                  ["Correo", profile?.email || "—"],
                  ["Teléfono", profile?.phone || "—"],
                  ["Programa", profile?.program || "—"],
                  ["Plantel", profile?.plantelNames.join(", ") || "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs uppercase tracking-wide text-[var(--aula-text-muted)]">
                      {label}
                    </dt>
                    <dd className="mt-1 break-words text-sm text-[var(--aula-text)]">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
              <h2 className="flex items-center gap-2 font-semibold text-[var(--aula-text)]">
                <ShieldCheck size={18} className="text-[var(--aula-accent-soft)]" />
                Cambiar contraseña
              </h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="Nueva contraseña"
                  className="rounded-lg border border-[var(--aula-border)] bg-[var(--aula-bg)] px-3 py-2.5 text-sm text-[var(--aula-text)] outline-none placeholder:text-[var(--aula-text-muted)] focus:border-[var(--aula-accent)]"
                />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Confirmar contraseña"
                  className="rounded-lg border border-[var(--aula-border)] bg-[var(--aula-bg)] px-3 py-2.5 text-sm text-[var(--aula-text)] outline-none placeholder:text-[var(--aula-text-muted)] focus:border-[var(--aula-accent)]"
                />
              </div>
              <button
                type="button"
                onClick={handleChangePassword}
                disabled={changingPassword || !newPassword || !confirmPassword}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--aula-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {changingPassword && <Loader2 size={16} className="animate-spin" />}
                Actualizar contraseña
              </button>
            </section>

            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2.5 text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              <LogOut size={16} />
              Cerrar sesión
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
