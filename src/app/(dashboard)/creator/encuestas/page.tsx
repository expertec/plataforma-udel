"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import { isAdminTeacherRole, resolveUserRole, type UserRole } from "@/lib/firebase/roles";
import {
  createSatisfactionSurvey,
  getSatisfactionSurveys,
  getSurveyResponsesBySurveyId,
  setSatisfactionSurveyStatus,
  updateSatisfactionSurvey,
  type SatisfactionSurvey,
  type SurveyQuestion,
  type SurveyQuestionOption,
  type SurveyResponse,
  type SurveySegment,
  type SurveyStatus,
} from "@/lib/firebase/satisfaction-surveys-service";
import {
  listClassEvaluations,
  type ClassEvaluation,
} from "@/lib/firebase/class-evaluations-service";
import type { FirebaseError } from "firebase/app";

type SurveyFormState = {
  title: string;
  description: string;
  segment: SurveySegment;
  applyToFutureStudents: boolean;
  questions: SurveyQuestion[];
};

type SurveyStatusCounts = Record<string, number>;

const EMPTY_FORM: SurveyFormState = {
  title: "",
  description: "",
  segment: "all",
  applyToFutureStudents: true,
  questions: [],
};

const SEGMENT_LABELS: Record<SurveySegment, string> = {
  all: "Todos",
  new_60d: "Nuevos (<= 60 días)",
  old_60d: "Antiguos (> 60 días)",
};

const STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: "Borrador",
  published: "Publicada",
  archived: "Archivada",
};

const STATUS_CLASS: Record<SurveyStatus, string> = {
  draft: "bg-amber-100 text-amber-700",
  published: "bg-emerald-100 text-emerald-700",
  archived: "bg-slate-100 text-slate-700",
};

const formatDateTime = (value: Date | null | undefined): string => {
  if (!value || Number.isNaN(value.getTime())) return "N/D";
  return value.toLocaleString("es-MX");
};

const safeId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const buildQuestion = (type: SurveyQuestion["type"]): SurveyQuestion => ({
  id: safeId(),
  type,
  label: "",
  required: true,
  ...(type === "single_choice"
    ? {
        options: [
          { id: safeId(), label: "Opción 1" },
          { id: safeId(), label: "Opción 2" },
        ] as SurveyQuestionOption[],
      }
    : {}),
});

const toDateFromInput = (value: string, endOfDay = false): Date | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const date = new Date(`${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const getAnswerValue = (response: SurveyResponse, questionId: string): string | number | null => {
  const answer = response.answers.find((item) => item.questionId === questionId);
  return answer ? answer.value : null;
};

const errorCodeSuffix = (error: unknown): string => {
  const code = (error as FirebaseError | undefined)?.code;
  return code ? ` (${code})` : "";
};

export default function EncuestasPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [roleReady, setRoleReady] = useState(false);

  const [surveys, setSurveys] = useState<SatisfactionSurvey[]>([]);
  const [surveysLoading, setSurveysLoading] = useState(true);
  const [savingSurvey, setSavingSurvey] = useState(false);
  const [editingSurveyId, setEditingSurveyId] = useState<string | null>(null);
  const [form, setForm] = useState<SurveyFormState>(EMPTY_FORM);
  const [statusUpdatingId, setStatusUpdatingId] = useState<string | null>(null);

  const [responsesBySurvey, setResponsesBySurvey] = useState<Record<string, SurveyResponse[]>>({});
  const [responsesLoadingId, setResponsesLoadingId] = useState<string | null>(null);
  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);

  const [evaluations, setEvaluations] = useState<ClassEvaluation[]>([]);
  const [evaluationsLoading, setEvaluationsLoading] = useState(true);
  const [evaluationsCourseFilter, setEvaluationsCourseFilter] = useState("");
  const [evaluationsStartDate, setEvaluationsStartDate] = useState("");
  const [evaluationsEndDate, setEvaluationsEndDate] = useState("");

  const canManageSurveys = isAdminTeacherRole(userRole);

  const selectedSurvey = useMemo(
    () => surveys.find((survey) => survey.id === selectedSurveyId) ?? null,
    [selectedSurveyId, surveys],
  );

  const selectedSurveyResponses = useMemo(
    () => (selectedSurveyId ? responsesBySurvey[selectedSurveyId] ?? [] : []),
    [selectedSurveyId, responsesBySurvey],
  );

  const surveyResponseCounts: SurveyStatusCounts = useMemo(() => {
    const next: SurveyStatusCounts = {};
    Object.entries(responsesBySurvey).forEach(([surveyId, entries]) => {
      next[surveyId] = entries.length;
    });
    return next;
  }, [responsesBySurvey]);

  const evaluationSummary = useMemo(() => {
    if (evaluations.length === 0) {
      return {
        total: 0,
        average: 0,
        counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>,
      };
    }
    const counts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    evaluations.forEach((entry) => {
      sum += entry.rating;
      counts[entry.rating] += 1;
    });
    return {
      total: evaluations.length,
      average: Number((sum / evaluations.length).toFixed(2)),
      counts,
    };
  }, [evaluations]);

  const evaluationsWithComment = useMemo(
    () => evaluations.filter((entry) => entry.comment.trim().length > 0),
    [evaluations],
  );

  const surveyStats = useMemo(() => {
    return surveys.reduce(
      (acc, survey) => {
        acc.total += 1;
        acc[survey.status] += 1;
        return acc;
      },
      { total: 0, draft: 0, published: 0, archived: 0 },
    );
  }, [surveys]);

  const loadSurveys = useCallback(async () => {
    setSurveysLoading(true);
    try {
      const data = await getSatisfactionSurveys();
      setSurveys(data);
    } catch (error) {
      console.error("No se pudieron cargar las encuestas:", error);
      toast.error(`No se pudieron cargar las encuestas${errorCodeSuffix(error)}`);
    } finally {
      setSurveysLoading(false);
    }
  }, []);

  const loadResponsesForSurvey = useCallback(async (surveyId: string) => {
    if (!surveyId.trim()) return;
    setResponsesLoadingId(surveyId);
    try {
      const responses = await getSurveyResponsesBySurveyId(surveyId);
      setResponsesBySurvey((prev) => ({ ...prev, [surveyId]: responses }));
    } catch (error) {
      console.error(`No se pudieron cargar respuestas de encuesta ${surveyId}:`, error);
      toast.error("No se pudieron cargar las respuestas de la encuesta");
    } finally {
      setResponsesLoadingId(null);
    }
  }, []);

  const refreshAllSurveyResponses = useCallback(async (items: SatisfactionSurvey[]) => {
    if (!items.length) {
      setResponsesBySurvey({});
      return;
    }
    const entries = await Promise.all(
      items.map(async (survey) => {
        try {
          const responses = await getSurveyResponsesBySurveyId(survey.id);
          return [survey.id, responses] as const;
        } catch (error) {
          console.warn(`No se pudieron cargar respuestas para ${survey.id}:`, error);
          return [survey.id, []] as const;
        }
      }),
    );
    setResponsesBySurvey(
      entries.reduce<Record<string, SurveyResponse[]>>((acc, [id, responses]) => {
        acc[id] = responses;
        return acc;
      }, {}),
    );
  }, []);

  const loadClassEvaluationsData = useCallback(async () => {
    setEvaluationsLoading(true);
    try {
      const data = await listClassEvaluations({
        courseId: evaluationsCourseFilter.trim() || undefined,
        startDate: toDateFromInput(evaluationsStartDate),
        endDate: toDateFromInput(evaluationsEndDate, true),
        maxResults: 5000,
      });
      setEvaluations(data);
    } catch (error) {
      console.error("No se pudo cargar analítica de evaluaciones:", error);
      toast.error(`No se pudieron cargar las evaluaciones de clase${errorCodeSuffix(error)}`);
    } finally {
      setEvaluationsLoading(false);
    }
  }, [evaluationsCourseFilter, evaluationsStartDate, evaluationsEndDate]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setUserRole(null);
        setRoleReady(true);
        return;
      }
      try {
        const role = await resolveUserRole(user);
        setUserRole(role);
      } catch {
        setUserRole(null);
      } finally {
        setRoleReady(true);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!roleReady) return;
    if (userRole !== "adminTeacher" && userRole !== "superAdminTeacher") return;

    void (async () => {
      await loadSurveys();
      await loadClassEvaluationsData();
    })();
  }, [loadClassEvaluationsData, loadSurveys, roleReady, userRole]);

  useEffect(() => {
    if (!surveys.length) {
      setResponsesBySurvey({});
      return;
    }
    void refreshAllSurveyResponses(surveys);
  }, [refreshAllSurveyResponses, surveys]);

  const resetForm = () => {
    setEditingSurveyId(null);
    setForm(EMPTY_FORM);
  };

  const handleSaveSurvey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentUser) {
      toast.error("Debes iniciar sesión");
      return;
    }
    if (!canManageSurveys) {
      toast.error("No tienes permisos para gestionar encuestas");
      return;
    }
    const normalizedTitle = form.title.trim();
    if (!normalizedTitle) {
      toast.error("Agrega un título");
      return;
    }
    const validQuestions = form.questions.filter((question) => question.label.trim().length > 0);
    if (!validQuestions.length) {
      toast.error("Agrega al menos una pregunta");
      return;
    }

    setSavingSurvey(true);
    try {
      if (editingSurveyId) {
        await updateSatisfactionSurvey(editingSurveyId, {
          title: normalizedTitle,
          description: form.description.trim(),
          segment: form.segment,
          applyToFutureStudents: form.applyToFutureStudents,
          questions: validQuestions,
          updatedBy: currentUser.uid,
        });
        toast.success("Encuesta actualizada");
      } else {
        await createSatisfactionSurvey({
          title: normalizedTitle,
          description: form.description.trim(),
          status: "draft",
          segment: form.segment,
          applyToFutureStudents: form.applyToFutureStudents,
          questions: validQuestions,
          createdBy: currentUser.uid,
          updatedBy: currentUser.uid,
        });
        toast.success("Encuesta creada");
      }
      resetForm();
      await loadSurveys();
    } catch (error) {
      console.error("No se pudo guardar la encuesta:", error);
      toast.error("No se pudo guardar la encuesta");
    } finally {
      setSavingSurvey(false);
    }
  };

  const handleEditSurvey = (survey: SatisfactionSurvey) => {
    if (!canManageSurveys) return;
    setEditingSurveyId(survey.id);
    setForm({
      title: survey.title,
      description: survey.description,
      segment: survey.segment,
      applyToFutureStudents: survey.applyToFutureStudents,
      questions: survey.questions.length ? survey.questions : [buildQuestion("rating_1_5")],
    });
  };

  const handleChangeSurveyStatus = async (surveyId: string, status: SurveyStatus) => {
    if (!currentUser) {
      toast.error("Debes iniciar sesión");
      return;
    }
    if (!canManageSurveys) {
      toast.error("No tienes permisos para cambiar el estado");
      return;
    }
    setStatusUpdatingId(surveyId);
    try {
      await setSatisfactionSurveyStatus({
        surveyId,
        status,
        updatedBy: currentUser.uid,
      });
      toast.success("Estado actualizado");
      await loadSurveys();
    } catch (error) {
      console.error("No se pudo actualizar el estado:", error);
      toast.error("No se pudo actualizar el estado");
    } finally {
      setStatusUpdatingId(null);
    }
  };

  const updateQuestion = (questionId: string, updater: (question: SurveyQuestion) => SurveyQuestion) => {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.map((question) => (question.id === questionId ? updater(question) : question)),
    }));
  };

  const removeQuestion = (questionId: string) => {
    setForm((prev) => ({
      ...prev,
      questions: prev.questions.filter((question) => question.id !== questionId),
    }));
  };

  const addQuestion = (type: SurveyQuestion["type"]) => {
    setForm((prev) => ({
      ...prev,
      questions: [...prev.questions, buildQuestion(type)],
    }));
  };

  const addOption = (questionId: string) => {
    updateQuestion(questionId, (question) => ({
      ...question,
      options: [...(question.options ?? []), { id: safeId(), label: "" }],
    }));
  };

  const updateOption = (questionId: string, optionId: string, label: string) => {
    updateQuestion(questionId, (question) => ({
      ...question,
      options: (question.options ?? []).map((option) =>
        option.id === optionId ? { ...option, label } : option,
      ),
    }));
  };

  const removeOption = (questionId: string, optionId: string) => {
    updateQuestion(questionId, (question) => ({
      ...question,
      options: (question.options ?? []).filter((option) => option.id !== optionId),
    }));
  };

  if (!roleReady) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        Cargando permisos...
      </div>
    );
  }

  return (
    <RoleGate allowedRole={["adminTeacher", "superAdminTeacher"]}>
      <div className="space-y-6 text-slate-900">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Feedback</p>
          <h1 className="text-2xl font-semibold text-slate-900">Encuestas y evaluaciones de clase</h1>
          <p className="text-sm text-slate-600">
            {canManageSurveys
              ? "Gestiona encuestas, segmentación y revisa métricas de satisfacción."
              : "Consulta el estado de encuestas y la analítica de satisfacción estudiantil."}
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-4">
          <StatCard title="Total encuestas" value={surveyStats.total} />
          <StatCard title="Borradores" value={surveyStats.draft} />
          <StatCard title="Publicadas" value={surveyStats.published} />
          <StatCard title="Archivadas" value={surveyStats.archived} />
        </section>

        {canManageSurveys ? (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">
              {editingSurveyId ? "Editar encuesta" : "Nueva encuesta"}
            </h2>
            <form onSubmit={handleSaveSurvey} className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Título
                  <input
                    value={form.title}
                    onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Encuesta de satisfacción del curso"
                    required
                  />
                </label>
                <label className="space-y-1 text-sm font-medium text-slate-700">
                  Segmento
                  <select
                    value={form.segment}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, segment: event.target.value as SurveySegment }))
                    }
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="all">Todos</option>
                    <option value="new_60d">Nuevos (&lt;= 60 días)</option>
                    <option value="old_60d">Antiguos (&gt; 60 días)</option>
                  </select>
                </label>
              </div>

              <label className="space-y-1 text-sm font-medium text-slate-700">
                Descripción
                <textarea
                  value={form.description}
                  onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                  rows={2}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="Mensaje breve para el alumno"
                />
              </label>

              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={form.applyToFutureStudents}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      applyToFutureStudents: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-slate-300"
                />
                Mostrar también a alumnos que se registren después de publicar
              </label>

              <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Preguntas</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => addQuestion("rating_1_5")}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                    >
                      + Escala 1-5
                    </button>
                    <button
                      type="button"
                      onClick={() => addQuestion("single_choice")}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                    >
                      + Opción múltiple
                    </button>
                    <button
                      type="button"
                      onClick={() => addQuestion("text")}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                    >
                      + Texto
                    </button>
                  </div>
                </div>

                {form.questions.length === 0 ? (
                  <p className="text-xs text-slate-600">Agrega al menos una pregunta.</p>
                ) : (
                  <div className="space-y-3">
                    {form.questions.map((question, index) => (
                      <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="grid gap-3 md:grid-cols-[1.4fr_0.6fr_auto] md:items-center">
                          <label className="space-y-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                            Pregunta {index + 1}
                            <input
                              value={question.label}
                              onChange={(event) =>
                                updateQuestion(question.id, (current) => ({
                                  ...current,
                                  label: event.target.value,
                                }))
                              }
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                              placeholder="¿Qué te pareció la clase?"
                              required
                            />
                          </label>
                          <label className="space-y-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                            Tipo
                            <select
                              value={question.type}
                              onChange={(event) =>
                                updateQuestion(question.id, () => buildQuestion(event.target.value as SurveyQuestion["type"]))
                              }
                              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              <option value="rating_1_5">Escala 1-5</option>
                              <option value="single_choice">Opción múltiple</option>
                              <option value="text">Texto libre</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            onClick={() => removeQuestion(question.id)}
                            className="rounded-lg border border-rose-200 px-3 py-2 text-xs font-semibold text-rose-700 hover:border-rose-300"
                          >
                            Eliminar
                          </button>
                        </div>

                        <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={question.required}
                            onChange={(event) =>
                              updateQuestion(question.id, (current) => ({
                                ...current,
                                required: event.target.checked,
                              }))
                            }
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          Pregunta obligatoria
                        </label>

                        {question.type === "single_choice" ? (
                          <div className="mt-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                                Opciones
                              </p>
                              <button
                                type="button"
                                onClick={() => addOption(question.id)}
                                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                              >
                                + Opción
                              </button>
                            </div>
                            {(question.options ?? []).map((option) => (
                              <div key={option.id} className="flex items-center gap-2">
                                <input
                                  value={option.label}
                                  onChange={(event) => updateOption(question.id, option.id, event.target.value)}
                                  className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                                  placeholder="Texto de opción"
                                  required
                                />
                                <button
                                  type="button"
                                  onClick={() => removeOption(question.id, option.id)}
                                  className="rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-semibold text-rose-700 hover:border-rose-300"
                                >
                                  Quitar
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {editingSurveyId ? (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300"
                  >
                    Cancelar edición
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={savingSurvey}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {savingSurvey ? "Guardando..." : editingSurveyId ? "Guardar cambios" : "Crear encuesta"}
                </button>
              </div>
            </form>
          </section>
        ) : null}

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Encuestas</h2>
            <button
              type="button"
              onClick={() => void loadSurveys()}
              disabled={surveysLoading}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {surveysLoading ? "Cargando..." : "Refrescar"}
            </button>
          </div>

          {surveysLoading ? (
            <p className="mt-4 text-sm text-slate-600">Cargando encuestas...</p>
          ) : surveys.length === 0 ? (
            <p className="mt-4 text-sm text-slate-600">No hay encuestas registradas.</p>
          ) : (
            <div className="mt-4 space-y-3">
              {surveys.map((survey) => (
                <article key={survey.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">{survey.title}</h3>
                      <p className="text-xs text-slate-500">
                        Segmento: {SEGMENT_LABELS[survey.segment]} •{" "}
                        {survey.applyToFutureStudents ? "Incluye alumnos futuros" : "No incluye alumnos futuros"}
                      </p>
                      <p className="text-xs text-slate-500">
                        Actualizada: {formatDateTime(survey.updatedAt)} • Preguntas: {survey.questions.length}
                      </p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_CLASS[survey.status]}`}>
                      {STATUS_LABELS[survey.status]}
                    </span>
                  </div>

                  <p className="mt-2 text-sm text-slate-700">{survey.description || "Sin descripción"}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSurveyId(survey.id);
                        if (!responsesBySurvey[survey.id]) {
                          void loadResponsesForSurvey(survey.id);
                        }
                      }}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                    >
                      Ver respuestas ({surveyResponseCounts[survey.id] ?? 0})
                    </button>

                    {canManageSurveys ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleEditSurvey(survey)}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                        >
                          Editar
                        </button>
                        {survey.status !== "published" ? (
                          <button
                            type="button"
                            onClick={() => void handleChangeSurveyStatus(survey.id, "published")}
                            disabled={statusUpdatingId === survey.id}
                            className="rounded-lg border border-emerald-200 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Publicar
                          </button>
                        ) : null}
                        {survey.status !== "archived" ? (
                          <button
                            type="button"
                            onClick={() => void handleChangeSurveyStatus(survey.id, "archived")}
                            disabled={statusUpdatingId === survey.id}
                            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Archivar
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleChangeSurveyStatus(survey.id, "draft")}
                            disabled={statusUpdatingId === survey.id}
                            className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:border-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Regresar a borrador
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Analítica de evaluaciones de clase</h2>
            <button
              type="button"
              onClick={() => void loadClassEvaluationsData()}
              disabled={evaluationsLoading}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {evaluationsLoading ? "Cargando..." : "Aplicar filtros"}
            </button>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="space-y-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Course ID
              <input
                value={evaluationsCourseFilter}
                onChange={(event) => setEvaluationsCourseFilter(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                placeholder="Filtrar por courseId"
              />
            </label>
            <label className="space-y-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Desde
              <input
                type="date"
                value={evaluationsStartDate}
                onChange={(event) => setEvaluationsStartDate(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="space-y-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              Hasta
              <input
                type="date"
                value={evaluationsEndDate}
                onChange={(event) => setEvaluationsEndDate(event.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <StatCard title="Total evaluaciones" value={evaluationSummary.total} />
            <StatCard title="Promedio" value={evaluationSummary.average} />
            <StatCard title="Con comentario" value={evaluationsWithComment.length} />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            {(Object.keys(evaluationSummary.counts) as Array<keyof typeof evaluationSummary.counts>).map((star) => (
              <div key={star} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-center">
                <p className="text-xs font-semibold text-slate-500">{star} estrella{star === 1 ? "" : "s"}</p>
                <p className="text-lg font-semibold text-slate-900">{evaluationSummary.counts[star]}</p>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-slate-800">Comentarios recientes</h3>
            {evaluationsWithComment.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No hay comentarios en el filtro actual.</p>
            ) : (
              <div className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1">
                {evaluationsWithComment.slice(0, 150).map((entry) => (
                  <article key={entry.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-900">
                        {entry.classTitle || entry.classDocId} • {entry.rating}★
                      </p>
                      <p className="text-xs text-slate-500">{formatDateTime(entry.updatedAt)}</p>
                    </div>
                    <p className="text-xs text-slate-500">
                      {entry.studentName} • {entry.courseTitle || entry.courseId}
                    </p>
                    <p className="mt-2 text-sm text-slate-700">{entry.comment}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {selectedSurvey ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-6"
          onClick={() => setSelectedSurveyId(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-semibold text-slate-900">{selectedSurvey.title}</h3>
                <p className="text-sm text-slate-600">
                  {SEGMENT_LABELS[selectedSurvey.segment]} • Respuestas: {selectedSurveyResponses.length}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSurveyId(null)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300"
              >
                Cerrar
              </button>
            </div>

            {responsesLoadingId === selectedSurvey.id ? (
              <p className="mt-4 text-sm text-slate-600">Cargando respuestas...</p>
            ) : selectedSurveyResponses.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">No hay respuestas todavía.</p>
            ) : (
              <>
                <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="text-sm font-semibold text-slate-800">Resumen por pregunta</p>
                  {selectedSurvey.questions.map((question) => {
                    const answers = selectedSurveyResponses
                      .map((response) => getAnswerValue(response, question.id))
                      .filter((value) => value !== null);
                    if (answers.length === 0) {
                      return (
                        <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                          <p className="text-sm font-semibold text-slate-900">{question.label}</p>
                          <p className="text-xs text-slate-500">Sin respuestas</p>
                        </div>
                      );
                    }

                    if (question.type === "rating_1_5") {
                      const numeric = answers.filter((value): value is number => typeof value === "number");
                      const sum = numeric.reduce((acc, value) => acc + value, 0);
                      const avg = numeric.length ? (sum / numeric.length).toFixed(2) : "0.00";
                      return (
                        <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                          <p className="text-sm font-semibold text-slate-900">{question.label}</p>
                          <p className="text-xs text-slate-500">Promedio: {avg} ({numeric.length} respuestas)</p>
                        </div>
                      );
                    }

                    if (question.type === "single_choice") {
                      const counts = answers.reduce<Record<string, number>>((acc, answer) => {
                        const key = String(answer);
                        acc[key] = (acc[key] ?? 0) + 1;
                        return acc;
                      }, {});
                      return (
                        <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                          <p className="text-sm font-semibold text-slate-900">{question.label}</p>
                          <div className="mt-2 space-y-1 text-xs text-slate-600">
                            {Object.entries(counts).map(([option, count]) => (
                              <p key={option}>
                                {option}: {count}
                              </p>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={question.id} className="rounded-lg border border-slate-200 bg-white p-3">
                        <p className="text-sm font-semibold text-slate-900">{question.label}</p>
                        <p className="text-xs text-slate-500">
                          {answers.filter((value) => String(value).trim().length > 0).length} comentarios
                        </p>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 space-y-2">
                  <p className="text-sm font-semibold text-slate-800">Respuestas individuales</p>
                  <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                    {selectedSurveyResponses.map((response) => (
                      <article key={response.id} className="rounded-lg border border-slate-200 p-3">
                        <p className="text-sm font-semibold text-slate-900">
                          {response.studentName}{" "}
                          <span className="text-xs font-normal text-slate-500">({response.studentEmail || "sin correo"})</span>
                        </p>
                        <p className="text-xs text-slate-500">Enviada: {formatDateTime(response.submittedAt)}</p>
                        <div className="mt-2 space-y-1 text-sm text-slate-700">
                          {selectedSurvey.questions.map((question) => {
                            const value = getAnswerValue(response, question.id);
                            return (
                              <p key={question.id}>
                                <span className="font-semibold">{question.label}: </span>
                                {value === null || String(value).trim() === "" ? "Sin respuesta" : String(value)}
                              </p>
                            );
                          })}
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </RoleGate>
  );
}

function StatCard({ title, value }: { title: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}
