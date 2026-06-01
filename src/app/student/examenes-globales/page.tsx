"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { onAuthStateChanged } from "firebase/auth";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import {
  fetchGlobalExamAssignments,
  fetchGlobalExamAttemptPayload,
  submitGlobalExamAttempt,
  type GlobalExamAttemptPayload,
} from "@/lib/global-exams/client";
import {
  getGlobalExamCourseLabel,
  getGlobalExamReasonLabel,
  getGlobalExamStatusLabel,
  type GlobalExamAssignmentRecord,
} from "@/lib/global-exams/types";

export default function StudentGlobalExamsPage() {
  const [loading, setLoading] = useState(true);
  const [assignments, setAssignments] = useState<GlobalExamAssignmentRecord[]>([]);
  const [activeExam, setActiveExam] = useState<GlobalExamAttemptPayload | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [openingAssignmentId, setOpeningAssignmentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  const loadAssignments = async () => {
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
  };

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
  }, []);

  const handleOpenExam = async (assignmentId: string) => {
    setOpeningAssignmentId(assignmentId);
    try {
      const payload = await fetchGlobalExamAttemptPayload(assignmentId);
      setActiveExam(payload);
      setAnswers({});
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo abrir el examen");
    } finally {
      setOpeningAssignmentId(null);
    }
  };

  const handleSubmitExam = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeExam) return;

    const unanswered = activeExam.questions.filter((question) => !answers[question.id]);
    if (unanswered.length > 0) {
      toast.error("Responde todas las preguntas antes de enviar");
      return;
    }

    setSubmitting(true);
    try {
      const result = await submitGlobalExamAttempt(activeExam.assignment.id, answers);
      toast.success(
        result.attempt.passed
          ? `Aprobaste con ${result.attempt.score}`
          : `Intento enviado con ${result.attempt.score}`,
      );
      if (!result.gradeSynced) {
        toast.error("El intento se guardo, pero la sincronizacion a kardex quedo pendiente");
      }
      setActiveExam(null);
      setAnswers({});
      await loadAssignments();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo enviar el examen");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <RoleGate allowedRole="student">
      <div className="min-h-screen bg-slate-50 px-4 py-6 text-slate-900 sm:px-6">
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
                href="/student"
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
              >
                Volver al feed
              </Link>
              <Link
                href="/student/profile"
                className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
              >
                Ir a perfil
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
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setActiveExam(null);
                    setAnswers({});
                  }}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700"
                >
                  Cerrar
                </button>
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
                  {submitting ? "Enviando..." : "Enviar examen"}
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
