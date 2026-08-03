"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { onAuthStateChanged } from "firebase/auth";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import {
  fetchGlobalExamAssignments,
  fetchGlobalExamAttemptPayload,
  getGlobalExamSessionToken,
  submitGlobalExamAttempt,
  type GlobalExamAttemptPayload,
} from "@/lib/global-exams/client";
import {
  getGlobalExamCourseLabel,
  getGlobalExamReasonLabel,
  getGlobalExamStatusLabel,
  type GlobalExamAttemptCompletionReason,
  type GlobalExamAssignmentRecord,
} from "@/lib/global-exams/types";

type StudentGlobalExamsPageProps = {
  backHref?: string;
  backLabel?: string;
  profileHref?: string;
  profileLabel?: string;
};

function formatRemainingTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatElapsedTime(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} h ${minutes.toString().padStart(2, "0")} min`;
  }
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

export default function StudentGlobalExamsPage({
  backHref = "/student",
  backLabel = "Volver al feed",
  profileHref = "/student/profile",
  profileLabel = "Ir a perfil",
}: StudentGlobalExamsPageProps) {
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState<GlobalExamAssignmentRecord[]>([]);
  const [activeExam, setActiveExam] = useState<GlobalExamAttemptPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [openingAssignmentId, setOpeningAssignmentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [timeLeftMs, setTimeLeftMs] = useState(0);
  const [activeSessionToken, setActiveSessionToken] = useState<string | null>(null);

  const activeExamRef = useRef<GlobalExamAttemptPayload | null>(null);
  const answersRef = useRef<Record<string, string>>({});
  const activeSessionTokenRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  const closingReasonRef = useRef<GlobalExamAttemptCompletionReason | null>(null);
  const pageRootRef = useRef<HTMLDivElement | null>(null);

  const openAssignments = useMemo(
    () =>
      assignments.filter(
        (assignment) =>
          assignment.enabled &&
          assignment.status === "enabled" &&
          assignment.attemptsUsed < assignment.attemptsAllowed,
      ),
    [assignments],
  );

  const completedAssignments = useMemo(
    () => assignments.filter((assignment) => assignment.status !== "enabled" || !assignment.enabled),
    [assignments],
  );

  useEffect(() => {
    activeExamRef.current = activeExam;
  }, [activeExam]);

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    activeSessionTokenRef.current = activeSessionToken;
  }, [activeSessionToken]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    try {
      const loadedAssignments = await fetchGlobalExamAssignments();
      setAssignments(loadedAssignments);
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudieron cargar tus examenes globales",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const requestExamFullscreen = useCallback(async () => {
    const target = pageRootRef.current;
    if (!target?.requestFullscreen) return false;
    if (document.fullscreenElement === target) return true;
    try {
      await target.requestFullscreen();
      return true;
    } catch (error) {
      console.warn("No se pudo activar pantalla completa para el examen:", error);
      return false;
    }
  }, []);

  const exitExamFullscreen = useCallback(async () => {
    if (!document.fullscreenElement || !document.exitFullscreen) return;
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.warn("No se pudo salir de pantalla completa:", error);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setAssignments([]);
        setLoading(false);
        return;
      }
      await loadAssignments();
    });
    return () => unsub();
  }, [loadAssignments]);

  const handleOpenExam = async (assignmentId: string) => {
    setOpeningAssignmentId(assignmentId);
    try {
      const fullscreenEnabled = await requestExamFullscreen();
      const [payload, token] = await Promise.all([
        fetchGlobalExamAttemptPayload(assignmentId),
        getGlobalExamSessionToken(),
      ]);
      setActiveExam(payload);
      setAnswers({});
      setActiveSessionToken(token);
      setTimeLeftMs(Math.max(0, new Date(payload.session.deadlineAt).getTime() - Date.now()));
      if (!fullscreenEnabled) {
        toast.error("No se pudo activar pantalla completa. Si sales o cambias de pestaña, el examen se cerrará.");
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      await exitExamFullscreen();
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo abrir el examen");
    } finally {
      setOpeningAssignmentId(null);
    }
  };

  const resetActiveExamState = useCallback(() => {
    setActiveExam(null);
    setAnswers({});
    setActiveSessionToken(null);
    setTimeLeftMs(0);
    void exitExamFullscreen();
  }, [exitExamFullscreen]);

  const finalizeExam = useCallback(
    async (
      completionReason: GlobalExamAttemptCompletionReason,
      options?: {
        suppressSuccessToast?: boolean;
        suppressErrorToast?: boolean;
        keepalive?: boolean;
        shouldReloadAssignments?: boolean;
      },
    ) => {
      const exam = activeExamRef.current;
      if (!exam || submittingRef.current || closingReasonRef.current) {
        return false;
      }

      closingReasonRef.current = completionReason;
      setSubmitting(true);

      try {
        const result = await submitGlobalExamAttempt(exam.assignment.id, answersRef.current, {
          completionReason,
          token: options?.keepalive ? activeSessionTokenRef.current ?? undefined : undefined,
          keepalive: options?.keepalive,
        });

        if (!options?.suppressSuccessToast) {
          if (completionReason === "timeout") {
            toast.error("Se agotó el tiempo. El examen se cerró automáticamente.");
          } else if (completionReason === "visibility_change") {
            toast.error("El examen se cerró por cambiar de pestaña o salir de la ventana.");
          } else if (completionReason === "page_exit") {
            toast.error("El examen se cerró al salir de la página.");
          } else {
            toast.success(
              result.attempt.passed
                ? `Aprobaste con ${result.attempt.score}`
                : `Intento enviado con ${result.attempt.score}`,
            );
          }
        }

        if (!result.gradeSynced) {
          toast.error("El intento se guardo, pero la sincronizacion a kardex quedo pendiente");
        }

        resetActiveExamState();
        if (options?.shouldReloadAssignments !== false) {
          await loadAssignments();
        }
        return true;
      } catch (error) {
        console.error(error);
        if (!options?.suppressErrorToast) {
          toast.error(error instanceof Error ? error.message : "No se pudo cerrar el examen");
        }
        return false;
      } finally {
        closingReasonRef.current = null;
        setSubmitting(false);
      }
    },
    [loadAssignments, resetActiveExamState],
  );

  const handleSubmitExam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeExam) return;

    const unanswered = activeExam.questions.filter((question) => !answers[question.id]);
    if (unanswered.length > 0) {
      toast.error("Responde todas las preguntas antes de enviar");
      return;
    }

    await finalizeExam("submitted");
  };

  useEffect(() => {
    if (!activeExam) {
      setTimeLeftMs(0);
      return;
    }

    const deadlineTs = new Date(activeExam.session.deadlineAt).getTime();
    const updateRemaining = () => {
      const nextMs = Math.max(0, deadlineTs - Date.now());
      setTimeLeftMs(nextMs);
      if (nextMs <= 0 && !submittingRef.current && !closingReasonRef.current) {
        void finalizeExam("timeout");
      }
    };

    updateRemaining();
    const timerId = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timerId);
  }, [activeExam, finalizeExam]);

  useEffect(() => {
    if (!activeExam) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (submittingRef.current || closingReasonRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    const handlePageHide = () => {
      if (submittingRef.current || closingReasonRef.current) return;
      void finalizeExam("page_exit", {
        suppressSuccessToast: true,
        suppressErrorToast: true,
        keepalive: true,
        shouldReloadAssignments: false,
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      if (submittingRef.current || closingReasonRef.current) return;
      window.alert("¿Quieres terminar el examen? El examen se cerrará al cambiar de pestaña o salir.");
      void finalizeExam("visibility_change", {
        suppressSuccessToast: true,
        keepalive: true,
      });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeExam, finalizeExam]);

  useEffect(() => {
    if (!activeExam) return;

    const handleFullscreenChange = () => {
      if (submittingRef.current || closingReasonRef.current) return;
      if (document.fullscreenElement === pageRootRef.current) return;
      window.alert("Saliste de pantalla completa. El examen se cerrará automáticamente.");
      void finalizeExam("visibility_change", {
        suppressSuccessToast: true,
      });
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [activeExam, finalizeExam]);

  return (
    <RoleGate allowedRole="student">
      <div
        ref={pageRootRef}
        className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:px-6 [&:fullscreen]:h-screen [&:fullscreen]:overflow-y-auto"
      >
        <div className="mx-auto max-w-5xl space-y-6">
          <header className="flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Regularizacion</p>
              <h1 className="text-3xl font-semibold">Mis examenes globales</h1>
              <p className="max-w-2xl text-sm text-slate-600">
                Aqui veras los examenes habilitados especificamente para ti y el resultado que se
                sincroniza como calificacion final.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href={backHref}
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
              >
                {backLabel}
              </Link>
              <Link
                href={profileHref}
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
              >
                {profileLabel}
              </Link>
            </div>
          </header>

          {activeExam ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                    Examen en curso
                  </p>
                  <h2 className="text-2xl font-semibold text-slate-900">
                    {activeExam.template.title}
                  </h2>
                  <p className="text-sm text-slate-600">
                    {getGlobalExamCourseLabel(activeExam.template.courseName)} | Grupo{" "}
                    {activeExam.assignment.groupName}
                  </p>
                  <p className="text-sm text-slate-600">
                    Pase con {activeExam.template.passScore} | Intento {activeExam.assignment.attemptsUsed + 1} de{" "}
                    {activeExam.assignment.attemptsAllowed}
                  </p>
                  <p className="text-sm text-amber-700">
                    Tienes 40 minutos. El examen se abre en pantalla completa y se termina si
                    cambias de pestaña, sales de la página o cierras la pantalla completa.
                  </p>
                </div>
                <div className="flex flex-col items-start gap-3 sm:items-end">
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-right">
                    <p className="text-xs uppercase tracking-[0.14em] text-red-500">Tiempo restante</p>
                    <p className="text-2xl font-semibold text-red-700">{formatRemainingTime(timeLeftMs)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !window.confirm(
                          "¿Quieres terminar el examen? Se enviarán tus respuestas actuales y se cerrará el intento.",
                        )
                      ) {
                        return;
                      }
                      void finalizeExam("submitted");
                    }}
                    disabled={submitting}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700"
                  >
                    {submitting ? "Cerrando..." : "Terminar examen"}
                  </button>
                </div>
              </div>

              {activeExam.template.description ? (
                <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                  {activeExam.template.description}
                </div>
              ) : null}

              <form className="mt-6 space-y-4" onSubmit={handleSubmitExam}>
                {activeExam.questions.map((question, index) => (
                  <article
                    key={question.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <p className="text-xs uppercase tracking-[0.14em] text-slate-500">
                      Pregunta {index + 1}
                    </p>
                    <h3 className="mt-2 text-base font-semibold text-slate-900">{question.prompt}</h3>
                    <div className="mt-4 grid gap-3">
                      {question.options.map((option) => (
                        <label
                          key={`${question.id}-${option.id}`}
                          className={`rounded-2xl border px-4 py-3 text-sm transition ${
                            answers[question.id] === option.id
                              ? "border-blue-400 bg-blue-50"
                              : "border-slate-200 bg-white"
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="radio"
                              name={`answer-${question.id}`}
                              checked={answers[question.id] === option.id}
                              onChange={() =>
                                setAnswers((prev) => ({
                                  ...prev,
                                  [question.id]: option.id,
                                }))
                              }
                              className="mt-1 h-4 w-4 accent-blue-600"
                            />
                            <span>{option.text}</span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </article>
                ))}

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "Cerrando examen..." : "Enviar examen"}
                </button>
              </form>
            </section>
          ) : null}

          <section className="grid gap-4 md:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Disponibles</p>
              <p className="mt-2 text-3xl font-semibold">{openAssignments.length}</p>
              <p className="mt-1 text-sm text-slate-600">Examenes que puedes responder ahora</p>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Historico</p>
              <p className="mt-2 text-3xl font-semibold">{assignments.length}</p>
              <p className="mt-1 text-sm text-slate-600">Asignaciones registradas para tu perfil</p>
            </article>
          </section>

          {loading ? (
            <section className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
              Cargando examenes globales...
            </section>
          ) : null}

          {!loading ? (
            <section className="space-y-6">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                      Listos para responder
                    </p>
                    <h2 className="text-2xl font-semibold text-slate-900">Examenes habilitados</h2>
                  </div>
                </div>
                {openAssignments.length === 0 ? (
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                    En este momento no tienes examenes globales habilitados.
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {openAssignments.map((assignment) => (
                      <article
                        key={assignment.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-lg font-semibold text-slate-900">
                                {getGlobalExamCourseLabel(assignment.courseName)}
                              </h3>
                              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                                {getGlobalExamStatusLabel(assignment.status)}
                              </span>
                            </div>
                            <p className="text-sm text-slate-600">Grupo {assignment.groupName}</p>
                            <p className="text-xs text-slate-500">
                              {getGlobalExamReasonLabel(assignment.reason)} | Intentos usados:{" "}
                              {assignment.attemptsUsed}/{assignment.attemptsAllowed}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void handleOpenExam(assignment.id)}
                            disabled={openingAssignmentId === assignment.id}
                            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {openingAssignmentId === assignment.id ? "Abriendo..." : "Presentar examen"}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Seguimiento</p>
                  <h2 className="text-2xl font-semibold text-slate-900">Asignaciones cerradas o pendientes</h2>
                </div>
                {completedAssignments.length === 0 ? (
                  <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                    Aun no tienes historico de examenes globales.
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {completedAssignments.map((assignment) => (
                      <article
                        key={assignment.id}
                        className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="text-lg font-semibold text-slate-900">
                                {getGlobalExamCourseLabel(assignment.courseName)}
                              </h3>
                              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                                {getGlobalExamStatusLabel(assignment.status)}
                              </span>
                            </div>
                            <p className="text-sm text-slate-600">Grupo {assignment.groupName}</p>
                            <p className="text-xs text-slate-500">
                              {getGlobalExamReasonLabel(assignment.reason)} | Intentos usados:{" "}
                              {assignment.attemptsUsed}/{assignment.attemptsAllowed}
                            </p>
                          </div>
                          <div className="text-right text-sm text-slate-700">
                            <p className="font-semibold">
                              {assignment.latestScore !== null
                                ? `Ultima nota: ${assignment.latestScore}`
                                : "Sin intentos registrados"}
                            </p>
                            {formatElapsedTime(assignment.latestAttemptDurationSeconds) ? (
                              <p className="text-xs text-slate-500">
                                Tiempo usado: {formatElapsedTime(assignment.latestAttemptDurationSeconds)}
                              </p>
                            ) : null}
                            <p className="text-xs text-slate-500">
                              Mejor nota: {assignment.bestScore ?? "N/D"}
                            </p>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </RoleGate>
  );
}
