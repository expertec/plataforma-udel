"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
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
  enabled: boolean;
  segment: SurveySegment;
  applyToFutureStudents: boolean;
  questions: SurveyQuestion[];
};

type SurveyStatusCounts = Record<string, number>;

const EMPTY_FORM: SurveyFormState = {
  title: "",
  description: "",
  enabled: false,
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
const RATING_STARS: Array<1 | 2 | 3 | 4 | 5> = [1, 2, 3, 4, 5];

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

type ClassInsight = {
  classKey: string;
  classLabel: string;
  courseLabel: string;
  lessonLabel: string;
  responses: number;
  average: number;
  lowCount: number;
  highCount: number;
  commentsCount: number;
  lowRate: number;
  commentsRate: number;
  severityScore: number;
  lastUpdatedAt: Date | null;
};

type CourseInsight = {
  courseKey: string;
  courseLabel: string;
  responses: number;
  average: number;
  lowCount: number;
  highCount: number;
  commentsCount: number;
  lowRate: number;
  commentsRate: number;
  severityScore: number;
};

type CommentTopicInsight = {
  id: string;
  label: string;
  count: number;
  rate: number;
  decisionHint: string;
};

type TrendInsight = {
  recentCount: number;
  previousCount: number;
  recentAverage: number | null;
  previousAverage: number | null;
  deltaAverage: number | null;
  recentLowRate: number | null;
  previousLowRate: number | null;
  deltaLowRate: number | null;
};

type SurveyQuestionInsight = {
  questionId: string;
  label: string;
  type: SurveyQuestion["type"];
  answeredCount: number;
  missingCount: number;
  average?: number;
  lowRate?: number;
  severityScore?: number;
  optionsSummary?: Array<{ option: string; count: number; rate: number }>;
  topTopics?: Array<{ label: string; count: number; rate: number }>;
};

const REPORT_MIN_SAMPLE = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const COMMENT_TOPIC_RULES: Array<{
  id: string;
  label: string;
  keywords: string[];
  decisionHint: string;
}> = [
  {
    id: "clarity",
    label: "Claridad de explicacion",
    keywords: ["confus", "claro", "explica", "entendi", "duda"],
    decisionHint: "Revisar secuencia didactica y simplificar explicaciones clave.",
  },
  {
    id: "pace",
    label: "Ritmo y carga",
    keywords: ["rapido", "lento", "tiempo", "carga", "pesad", "tarea", "demasiado"],
    decisionHint: "Ajustar ritmo, dividir contenido y equilibrar carga por sesion.",
  },
  {
    id: "difficulty",
    label: "Dificultad del contenido",
    keywords: ["dificil", "complej", "complicad", "no entiendo"],
    decisionHint: "Agregar ejemplos guiados y prerequisitos antes de temas complejos.",
  },
  {
    id: "material",
    label: "Calidad de materiales",
    keywords: ["material", "recurso", "pdf", "diaposit", "ejemplo", "guia"],
    decisionHint: "Actualizar material y agregar recursos practicos descargables.",
  },
  {
    id: "engagement",
    label: "Dinamica y participacion",
    keywords: ["aburr", "interes", "dinamic", "particip"],
    decisionHint: "Incorporar actividades interactivas y checkpoints de participacion.",
  },
  {
    id: "platform",
    label: "Problemas tecnicos/plataforma",
    keywords: ["audio", "video", "internet", "plataforma", "error", "falla", "no carga"],
    decisionHint: "Priorizar correcciones tecnicas de reproduccion y estabilidad.",
  },
  {
    id: "assessment",
    label: "Evaluacion y retroalimentacion",
    keywords: ["calific", "rubrica", "examen", "retroaliment"],
    decisionHint: "Revisar criterios de evaluacion y tiempos de retroalimentacion.",
  },
];

const normalizeForSearch = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const safeLabel = (value: string | null | undefined, fallback: string): string => {
  const normalized = (value ?? "").trim();
  return normalized || fallback;
};

const toRatioPercent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const roundTo2 = (value: number): number => Number(value.toFixed(2));
const truncateText = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, Math.max(maxLength - 1, 1))}…` : value;

const buildSeverityScore = (average: number, lowRate: number, responses: number): number => {
  const normalizedAverage = Math.max(0, Math.min(1, (5 - average) / 4));
  const sampleWeight = Math.min(1, responses / 8);
  return roundTo2((normalizedAverage * 0.65 + lowRate * 0.35) * sampleWeight * 100);
};

const buildClassInsights = (entries: ClassEvaluation[]): ClassInsight[] => {
  const map = new Map<
    string,
    {
      classKey: string;
      classLabel: string;
      courseLabel: string;
      lessonLabel: string;
      responses: number;
      ratingSum: number;
      lowCount: number;
      highCount: number;
      commentsCount: number;
      lastUpdatedAt: Date | null;
    }
  >();

  entries.forEach((entry) => {
    const classKey = safeLabel(entry.classDocId, entry.id);
    const classLabel = safeLabel(entry.classTitle, classKey);
    const courseLabel = safeLabel(entry.courseTitle, safeLabel(entry.courseId, "Curso sin ID"));
    const lessonLabel = safeLabel(entry.lessonTitle, safeLabel(entry.lessonId, "Leccion sin ID"));

    const current = map.get(classKey) ?? {
      classKey,
      classLabel,
      courseLabel,
      lessonLabel,
      responses: 0,
      ratingSum: 0,
      lowCount: 0,
      highCount: 0,
      commentsCount: 0,
      lastUpdatedAt: null,
    };

    current.responses += 1;
    current.ratingSum += entry.rating;
    if (entry.rating <= 2) current.lowCount += 1;
    if (entry.rating >= 4) current.highCount += 1;
    if (entry.comment.trim().length > 0) current.commentsCount += 1;
    if (
      entry.updatedAt &&
      (!current.lastUpdatedAt || entry.updatedAt.getTime() > current.lastUpdatedAt.getTime())
    ) {
      current.lastUpdatedAt = entry.updatedAt;
    }

    map.set(classKey, current);
  });

  return Array.from(map.values()).map((item) => {
    const average = item.responses > 0 ? item.ratingSum / item.responses : 0;
    const lowRate = item.responses > 0 ? item.lowCount / item.responses : 0;
    const commentsRate = item.responses > 0 ? item.commentsCount / item.responses : 0;
    return {
      classKey: item.classKey,
      classLabel: item.classLabel,
      courseLabel: item.courseLabel,
      lessonLabel: item.lessonLabel,
      responses: item.responses,
      average: roundTo2(average),
      lowCount: item.lowCount,
      highCount: item.highCount,
      commentsCount: item.commentsCount,
      lowRate,
      commentsRate,
      severityScore: buildSeverityScore(average, lowRate, item.responses),
      lastUpdatedAt: item.lastUpdatedAt,
    };
  });
};

const buildCourseInsights = (entries: ClassEvaluation[]): CourseInsight[] => {
  const map = new Map<
    string,
    {
      courseKey: string;
      courseLabel: string;
      responses: number;
      ratingSum: number;
      lowCount: number;
      highCount: number;
      commentsCount: number;
    }
  >();

  entries.forEach((entry) => {
    const courseKey = safeLabel(entry.courseId, "sin-curso");
    const courseLabel = safeLabel(entry.courseTitle, courseKey);
    const current = map.get(courseKey) ?? {
      courseKey,
      courseLabel,
      responses: 0,
      ratingSum: 0,
      lowCount: 0,
      highCount: 0,
      commentsCount: 0,
    };
    current.responses += 1;
    current.ratingSum += entry.rating;
    if (entry.rating <= 2) current.lowCount += 1;
    if (entry.rating >= 4) current.highCount += 1;
    if (entry.comment.trim().length > 0) current.commentsCount += 1;
    map.set(courseKey, current);
  });

  return Array.from(map.values()).map((item) => {
    const average = item.responses > 0 ? item.ratingSum / item.responses : 0;
    const lowRate = item.responses > 0 ? item.lowCount / item.responses : 0;
    const commentsRate = item.responses > 0 ? item.commentsCount / item.responses : 0;
    return {
      courseKey: item.courseKey,
      courseLabel: item.courseLabel,
      responses: item.responses,
      average: roundTo2(average),
      lowCount: item.lowCount,
      highCount: item.highCount,
      commentsCount: item.commentsCount,
      lowRate,
      commentsRate,
      severityScore: buildSeverityScore(average, lowRate, item.responses),
    };
  });
};

const buildCommentTopicInsights = (entries: ClassEvaluation[]): CommentTopicInsight[] => {
  if (!entries.length) return [];

  const counts = COMMENT_TOPIC_RULES.reduce<Record<string, number>>((acc, topic) => {
    acc[topic.id] = 0;
    return acc;
  }, {});

  entries.forEach((entry) => {
    const comment = normalizeForSearch(entry.comment);
    if (!comment) return;
    COMMENT_TOPIC_RULES.forEach((topic) => {
      if (topic.keywords.some((keyword) => comment.includes(keyword))) {
        counts[topic.id] += 1;
      }
    });
  });

  return COMMENT_TOPIC_RULES
    .map((topic) => ({
      id: topic.id,
      label: topic.label,
      count: counts[topic.id] ?? 0,
      rate: entries.length > 0 ? (counts[topic.id] ?? 0) / entries.length : 0,
      decisionHint: topic.decisionHint,
    }))
    .filter((topic) => topic.count > 0)
    .sort((a, b) => b.count - a.count);
};

const buildTrendInsight = (entries: ClassEvaluation[]): TrendInsight => {
  if (!entries.length) {
    return {
      recentCount: 0,
      previousCount: 0,
      recentAverage: null,
      previousAverage: null,
      deltaAverage: null,
      recentLowRate: null,
      previousLowRate: null,
      deltaLowRate: null,
    };
  }

  const nowMs = Date.now();
  const recentStartMs = nowMs - 14 * DAY_MS;
  const previousStartMs = nowMs - 28 * DAY_MS;

  const recent = entries.filter((entry) => {
    const time = entry.updatedAt?.getTime() ?? 0;
    return time >= recentStartMs && time <= nowMs;
  });
  const previous = entries.filter((entry) => {
    const time = entry.updatedAt?.getTime() ?? 0;
    return time >= previousStartMs && time < recentStartMs;
  });

  const averageOf = (items: ClassEvaluation[]): number | null =>
    items.length ? roundTo2(items.reduce((sum, item) => sum + item.rating, 0) / items.length) : null;
  const lowRateOf = (items: ClassEvaluation[]): number | null =>
    items.length ? items.filter((item) => item.rating <= 2).length / items.length : null;

  const recentAverage = averageOf(recent);
  const previousAverage = averageOf(previous);
  const recentLowRate = lowRateOf(recent);
  const previousLowRate = lowRateOf(previous);

  return {
    recentCount: recent.length,
    previousCount: previous.length,
    recentAverage,
    previousAverage,
    deltaAverage:
      recentAverage !== null && previousAverage !== null
        ? roundTo2(recentAverage - previousAverage)
        : null,
    recentLowRate,
    previousLowRate,
    deltaLowRate:
      recentLowRate !== null && previousLowRate !== null
        ? roundTo2(recentLowRate - previousLowRate)
        : null,
  };
};

const toValidRating = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 1 || parsed > 5) return null;
  return parsed;
};

const buildSurveyQuestionInsights = (
  survey: SatisfactionSurvey,
  responses: SurveyResponse[],
): SurveyQuestionInsight[] => {
  return survey.questions.map((question) => {
    const rawAnswers = responses.map((response) => getAnswerValue(response, question.id));
    const answered = rawAnswers.filter((value) => value !== null && String(value).trim() !== "");
    const missingCount = Math.max(responses.length - answered.length, 0);

    if (question.type === "rating_1_5") {
      const numeric = answered
        .map((value) => toValidRating(value))
        .filter((value): value is number => value !== null);
      const average = numeric.length > 0 ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : 0;
      const lowCount = numeric.filter((value) => value <= 2).length;
      const lowRate = numeric.length > 0 ? lowCount / numeric.length : 0;
      return {
        questionId: question.id,
        label: question.label,
        type: question.type,
        answeredCount: numeric.length,
        missingCount,
        average: roundTo2(average),
        lowRate,
        severityScore: buildSeverityScore(average, lowRate, numeric.length),
      };
    }

    if (question.type === "single_choice") {
      const counts = answered.reduce<Record<string, number>>((acc, answer) => {
        const option = String(answer).trim();
        if (!option) return acc;
        acc[option] = (acc[option] ?? 0) + 1;
        return acc;
      }, {});
      const optionsSummary = Object.entries(counts)
        .map(([option, count]) => ({
          option,
          count,
          rate: answered.length > 0 ? count / answered.length : 0,
        }))
        .sort((a, b) => b.count - a.count);

      return {
        questionId: question.id,
        label: question.label,
        type: question.type,
        answeredCount: answered.length,
        missingCount,
        optionsSummary,
      };
    }

    const normalizedComments = answered.map((value) => normalizeForSearch(String(value)));
    const topicCounts = COMMENT_TOPIC_RULES.reduce<Record<string, number>>((acc, topic) => {
      acc[topic.id] = 0;
      return acc;
    }, {});

    normalizedComments.forEach((comment) => {
      COMMENT_TOPIC_RULES.forEach((topic) => {
        if (topic.keywords.some((keyword) => comment.includes(keyword))) {
          topicCounts[topic.id] += 1;
        }
      });
    });

    const topTopics = COMMENT_TOPIC_RULES.map((topic) => ({
      label: topic.label,
      count: topicCounts[topic.id] ?? 0,
      rate: answered.length > 0 ? (topicCounts[topic.id] ?? 0) / answered.length : 0,
    }))
      .filter((topic) => topic.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      questionId: question.id,
      label: question.label,
      type: question.type,
      answeredCount: answered.length,
      missingCount,
      topTopics,
    };
  });
};

const buildSurveyCriticalCommentRows = (
  survey: SatisfactionSurvey,
  responses: SurveyResponse[],
): Array<{ studentName: string; studentEmail: string; submittedAt: Date | null; overallRating: number | null; comment: string }> => {
  const ratingQuestions = survey.questions.filter((question) => question.type === "rating_1_5");
  const textQuestions = survey.questions.filter((question) => question.type === "text");

  return responses
    .map((response) => {
      const ratingValues = ratingQuestions
        .map((question) => toValidRating(getAnswerValue(response, question.id)))
        .filter((value): value is number => value !== null);

      const overallRating =
        ratingValues.length > 0
          ? roundTo2(ratingValues.reduce((sum, value) => sum + value, 0) / ratingValues.length)
          : null;

      const comment = textQuestions
        .map((question) => {
          const value = getAnswerValue(response, question.id);
          return value === null ? "" : String(value).trim();
        })
        .filter(Boolean)
        .join(" | ");

      return {
        studentName: response.studentName || "Estudiante",
        studentEmail: response.studentEmail || "",
        submittedAt: response.submittedAt,
        overallRating,
        comment,
      };
    })
    .filter((row) => row.comment.length > 0)
    .sort((a, b) => {
      const left = a.overallRating ?? 999;
      const right = b.overallRating ?? 999;
      if (left !== right) return left - right;
      return (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0);
    })
    .slice(0, 10);
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
  const [surveyPdfLoadingId, setSurveyPdfLoadingId] = useState<string | null>(null);
  const [surveyExcelLoadingId, setSurveyExcelLoadingId] = useState<string | null>(null);
  const [selectedSurveyId, setSelectedSurveyId] = useState<string | null>(null);

  const [evaluations, setEvaluations] = useState<ClassEvaluation[]>([]);
  const [evaluationsLoading, setEvaluationsLoading] = useState(true);
  const [evaluationsPdfLoading, setEvaluationsPdfLoading] = useState(false);
  const [evaluationsExcelLoading, setEvaluationsExcelLoading] = useState(false);
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

  const lowRatingCount = useMemo(
    () => evaluationSummary.counts[1] + evaluationSummary.counts[2],
    [evaluationSummary],
  );

  const highRatingCount = useMemo(
    () => evaluationSummary.counts[4] + evaluationSummary.counts[5],
    [evaluationSummary],
  );

  const lowRatingRate = useMemo(
    () => (evaluationSummary.total > 0 ? lowRatingCount / evaluationSummary.total : 0),
    [evaluationSummary.total, lowRatingCount],
  );

  const commentsRate = useMemo(
    () =>
      evaluationSummary.total > 0 ? evaluationsWithComment.length / evaluationSummary.total : 0,
    [evaluationSummary.total, evaluationsWithComment.length],
  );

  const classInsights = useMemo(() => buildClassInsights(evaluations), [evaluations]);

  const courseInsights = useMemo(() => buildCourseInsights(evaluations), [evaluations]);

  const worstClassInsights = useMemo(
    () =>
      [...classInsights]
        .filter((item) => item.responses >= 2)
        .sort((a, b) => {
          if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
          if (a.average !== b.average) return a.average - b.average;
          return b.responses - a.responses;
        })
        .slice(0, 10),
    [classInsights],
  );

  const atRiskClassInsights = useMemo(
    () =>
      classInsights
        .filter((item) => item.responses >= REPORT_MIN_SAMPLE && item.average < 3)
        .sort((a, b) => a.average - b.average),
    [classInsights],
  );

  const atRiskCourseInsights = useMemo(
    () =>
      courseInsights
        .filter((item) => item.responses >= REPORT_MIN_SAMPLE && item.average < 3)
        .sort((a, b) => a.average - b.average),
    [courseInsights],
  );

  const commentTopicInsights = useMemo(
    () => buildCommentTopicInsights(evaluationsWithComment),
    [evaluationsWithComment],
  );

  const trendInsight = useMemo(() => buildTrendInsight(evaluations), [evaluations]);

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

  const getOrLoadResponsesForSurvey = useCallback(
    async (surveyId: string): Promise<SurveyResponse[]> => {
      const normalizedSurveyId = surveyId.trim();
      if (!normalizedSurveyId) return [];

      const cached = responsesBySurvey[normalizedSurveyId];
      if (cached) return cached;

      const responses = await getSurveyResponsesBySurveyId(normalizedSurveyId);
      setResponsesBySurvey((prev) => ({ ...prev, [normalizedSurveyId]: responses }));
      return responses;
    },
    [responsesBySurvey],
  );

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
          return [survey.id, [] as SurveyResponse[]] as const;
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

  const handleDownloadEvaluationsReportPdf = useCallback(async () => {
    if (!evaluations.length) {
      toast.error("No hay evaluaciones para generar el reporte.");
      return;
    }

    const highRatingRate =
      evaluationSummary.total > 0 ? highRatingCount / evaluationSummary.total : 0;

    const topCourseRisks = [...atRiskCourseInsights].slice(0, 8);
    const topClassRisks = [...worstClassInsights].slice(0, 12);
    const topTopics = [...commentTopicInsights].slice(0, 6);

    const recommendations: string[] = [];
    if (topClassRisks.length > 0) {
      recommendations.push(
        `Intervenir de inmediato las ${Math.min(
          5,
          topClassRisks.length,
        )} clases con mayor severidad (promedio bajo y alta tasa de 1-2 estrellas).`,
      );
    }
    if (topTopics.length > 0) {
      recommendations.push(
        `Priorizar mejoras en "${topTopics[0].label}" porque aparece en ${toRatioPercent(
          topTopics[0].rate,
        )} de los comentarios.`,
      );
    }
    if (lowRatingRate >= 0.25) {
      recommendations.push(
        "Activar plan correctivo docente para grupos con >=25% de evaluaciones criticas (1-2 estrellas).",
      );
    }
    if (trendInsight.deltaAverage !== null && trendInsight.deltaAverage <= -0.2) {
      recommendations.push(
        "El promedio reciente cayo frente a las 2 semanas previas; revisar cambios recientes de contenido o docente.",
      );
    }
    if (recommendations.length === 0) {
      recommendations.push(
        "Mantener monitoreo semanal y enfocar seguimiento en clases con bajo volumen para confirmar estabilidad.",
      );
    }

    setEvaluationsPdfLoading(true);
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 40;
      const topMargin = 46;
      const bottomMargin = 42;
      const contentWidth = pageWidth - marginX * 2;
      const bottomLimit = pageHeight - bottomMargin;
      let y = topMargin;

      const ensureSpace = (requiredHeight: number) => {
        if (y + requiredHeight <= bottomLimit) return;
        pdf.addPage();
        y = topMargin;
      };

      const drawTitle = (text: string) => {
        ensureSpace(30);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(18);
        pdf.setTextColor(15, 23, 42);
        pdf.text(text, marginX, y);
        y += 22;
      };

      const drawSection = (text: string) => {
        ensureSpace(24);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(13);
        pdf.setTextColor(30, 41, 59);
        pdf.text(text, marginX, y);
        y += 16;
      };

      const drawParagraph = (text: string, fontSize = 10, color: [number, number, number] = [71, 85, 105]) => {
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(fontSize);
        pdf.setTextColor(color[0], color[1], color[2]);
        const lines = pdf.splitTextToSize(text, contentWidth) as string[];
        ensureSpace(lines.length * 13 + 4);
        pdf.text(lines, marginX, y);
        y += lines.length * 13 + 4;
      };

      const drawKeyValue = (label: string, value: string) => {
        ensureSpace(14);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.setTextColor(30, 41, 59);
        pdf.text(label, marginX, y);
        pdf.setFont("helvetica", "normal");
        pdf.setTextColor(51, 65, 85);
        pdf.text(value, marginX + 190, y);
        y += 14;
      };

      const drawSimpleTable = (headers: string[], widths: number[], rows: string[][]) => {
        const rowHeight = 16;
        const headerHeight = 18;
        ensureSpace(headerHeight + rowHeight);

        let x = marginX;
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.setTextColor(30, 41, 59);
        headers.forEach((header, index) => {
          pdf.text(header, x + 2, y);
          x += widths[index];
        });
        y += 6;
        pdf.setDrawColor(148, 163, 184);
        pdf.line(marginX, y, marginX + contentWidth, y);
        y += 10;

        rows.forEach((row) => {
          ensureSpace(rowHeight + 6);
          let cellX = marginX;
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(9);
          pdf.setTextColor(51, 65, 85);
          row.forEach((cell, cellIndex) => {
            const maxChars = cellIndex <= 1 ? 34 : 16;
            pdf.text(truncateText(cell, maxChars), cellX + 2, y);
            cellX += widths[cellIndex];
          });
          y += 6;
          pdf.setDrawColor(226, 232, 240);
          pdf.line(marginX, y, marginX + contentWidth, y);
          y += 10;
        });
      };

      const periodText = `${evaluationsStartDate || "sin limite"} a ${evaluationsEndDate || "hoy"}`;
      const courseFilterText = evaluationsCourseFilter.trim() || "Todos los cursos";

      drawTitle("Reporte de decisiones - Evaluaciones de clase");
      drawParagraph(`Generado: ${new Date().toLocaleString("es-MX")}`, 10);
      drawParagraph(`Filtro de curso: ${courseFilterText}`, 10);
      drawParagraph(`Periodo: ${periodText}`, 10);
      y += 4;

      drawSection("1) Resumen ejecutivo");
      drawKeyValue("Total de evaluaciones", String(evaluationSummary.total));
      drawKeyValue("Promedio general", evaluationSummary.average.toFixed(2));
      drawKeyValue("Participacion con comentario", `${evaluationsWithComment.length} (${toRatioPercent(commentsRate)})`);
      drawKeyValue("Evaluaciones criticas (1-2)", `${lowRatingCount} (${toRatioPercent(lowRatingRate)})`);
      drawKeyValue("Evaluaciones positivas (4-5)", `${highRatingCount} (${toRatioPercent(highRatingRate)})`);
      drawKeyValue("Clases en riesgo (avg < 3, n >= 3)", String(atRiskClassInsights.length));
      drawKeyValue("Cursos en riesgo (avg < 3, n >= 3)", String(atRiskCourseInsights.length));

      const trendText =
        trendInsight.deltaAverage === null
          ? "No hay suficiente historico para comparar tendencia de 14 dias."
          : `Promedio ultimos 14 dias: ${trendInsight.recentAverage?.toFixed(2) ?? "N/D"} vs periodo previo: ${
              trendInsight.previousAverage?.toFixed(2) ?? "N/D"
            } (delta ${trendInsight.deltaAverage >= 0 ? "+" : ""}${trendInsight.deltaAverage.toFixed(2)}).`;
      drawParagraph(trendText);
      if (trendInsight.deltaLowRate !== null) {
        drawParagraph(
          `Tasa critica 1-2★ ultimos 14 dias: ${toRatioPercent(
            trendInsight.recentLowRate ?? 0,
          )} vs previo ${toRatioPercent(trendInsight.previousLowRate ?? 0)} (delta ${
            trendInsight.deltaLowRate >= 0 ? "+" : ""
          }${toRatioPercent(trendInsight.deltaLowRate)}).`,
        );
      }

      y += 6;
      drawSection("2) Top clases/contenidos peor puntuados");
      if (!topClassRisks.length) {
        drawParagraph("No hay suficiente muestra para construir ranking de clases.");
      } else {
        drawSimpleTable(
          ["#", "Clase/Contenido", "Curso", "Resp", "Avg", "%1-2", "Sev"],
          [24, 150, 106, 40, 44, 55, 96],
          topClassRisks.map((item, index) => [
            String(index + 1),
            item.classLabel,
            item.courseLabel,
            String(item.responses),
            item.average.toFixed(2),
            toRatioPercent(item.lowRate),
            `${item.severityScore.toFixed(1)} / 100`,
          ]),
        );
      }

      y += 6;
      drawSection("3) Cursos en riesgo por promedio");
      if (!topCourseRisks.length) {
        drawParagraph("No se detectaron cursos con promedio menor a 3 en la muestra actual.");
      } else {
        drawSimpleTable(
          ["Curso", "Resp", "Avg", "%1-2", "%coment", "Sev"],
          [220, 50, 50, 70, 70, 55],
          topCourseRisks.map((item) => [
            item.courseLabel,
            String(item.responses),
            item.average.toFixed(2),
            toRatioPercent(item.lowRate),
            toRatioPercent(item.commentsRate),
            item.severityScore.toFixed(1),
          ]),
        );
      }

      y += 6;
      drawSection("4) Temas recurrentes en comentarios");
      if (!topTopics.length) {
        drawParagraph("No hay suficiente texto en comentarios para clasificar temas.");
      } else {
        topTopics.forEach((topic, index) => {
          drawParagraph(
            `${index + 1}. ${topic.label}: ${topic.count} menciones (${toRatioPercent(topic.rate)}). ${topic.decisionHint}`,
          );
        });
      }

      y += 6;
      drawSection("5) Recomendaciones accionables");
      recommendations.forEach((item, index) => {
        drawParagraph(`${index + 1}. ${item}`);
      });

      y += 8;
      drawParagraph("Documento generado automaticamente por Plataforma UDEL.", 9, [100, 116, 139]);

      const dateToken = new Date().toISOString().slice(0, 10);
      const safeCourseToken = (evaluationsCourseFilter.trim() || "todos")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
      pdf.save(`reporte-evaluaciones-${safeCourseToken || "todos"}-${dateToken}.pdf`);
    } catch (error) {
      console.error("No se pudo generar el PDF de analitica:", error);
      toast.error("No se pudo generar el PDF. Intenta de nuevo.");
    } finally {
      setEvaluationsPdfLoading(false);
    }
  }, [
    atRiskClassInsights.length,
    atRiskCourseInsights,
    commentTopicInsights,
    commentsRate,
    evaluationSummary,
    evaluations,
    evaluationsCourseFilter,
    evaluationsEndDate,
    evaluationsStartDate,
    highRatingCount,
    lowRatingCount,
    lowRatingRate,
    evaluationsWithComment.length,
    trendInsight,
    worstClassInsights,
  ]);

  const handleDownloadEvaluationsReportExcel = useCallback(async () => {
    if (!evaluations.length) {
      toast.error("No hay evaluaciones para generar el reporte.");
      return;
    }

    const highRatingRate =
      evaluationSummary.total > 0 ? highRatingCount / evaluationSummary.total : 0;
    const topClassRisks = [...worstClassInsights].slice(0, 12);
    const topTopics = [...commentTopicInsights].slice(0, 6);
    const sortedClassInsights = [...classInsights].sort((a, b) => {
      if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
      if (a.average !== b.average) return a.average - b.average;
      return b.responses - a.responses;
    });
    const sortedCourseInsights = [...courseInsights].sort((a, b) => {
      if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
      if (a.average !== b.average) return a.average - b.average;
      return b.responses - a.responses;
    });

    const recommendations: string[] = [];
    if (topClassRisks.length > 0) {
      recommendations.push(
        `Intervenir de inmediato las ${Math.min(
          5,
          topClassRisks.length,
        )} clases con mayor severidad (promedio bajo y alta tasa de 1-2 estrellas).`,
      );
    }
    if (topTopics.length > 0) {
      recommendations.push(
        `Priorizar mejoras en "${topTopics[0].label}" porque aparece en ${toRatioPercent(
          topTopics[0].rate,
        )} de los comentarios.`,
      );
    }
    if (lowRatingRate >= 0.25) {
      recommendations.push(
        "Activar plan correctivo docente para grupos con >=25% de evaluaciones criticas (1-2 estrellas).",
      );
    }
    if (trendInsight.deltaAverage !== null && trendInsight.deltaAverage <= -0.2) {
      recommendations.push(
        "El promedio reciente cayo frente a las 2 semanas previas; revisar cambios recientes de contenido o docente.",
      );
    }
    if (!recommendations.length) {
      recommendations.push(
        "Mantener monitoreo semanal y enfocar seguimiento en clases con bajo volumen para confirmar estabilidad.",
      );
    }

    setEvaluationsExcelLoading(true);
    try {
      const periodText = `${evaluationsStartDate || "sin limite"} a ${evaluationsEndDate || "hoy"}`;
      const courseFilterText = evaluationsCourseFilter.trim() || "Todos los cursos";

      const summaryRows = [
        { Indicador: "Generado", Valor: new Date().toLocaleString("es-MX") },
        { Indicador: "Filtro de curso", Valor: courseFilterText },
        { Indicador: "Periodo", Valor: periodText },
        { Indicador: "Total evaluaciones", Valor: evaluationSummary.total },
        { Indicador: "Promedio general", Valor: evaluationSummary.average.toFixed(2) },
        {
          Indicador: "Participacion con comentario",
          Valor: `${evaluationsWithComment.length} (${toRatioPercent(commentsRate)})`,
        },
        {
          Indicador: "Evaluaciones criticas (1-2)",
          Valor: `${lowRatingCount} (${toRatioPercent(lowRatingRate)})`,
        },
        {
          Indicador: "Evaluaciones positivas (4-5)",
          Valor: `${highRatingCount} (${toRatioPercent(highRatingRate)})`,
        },
        {
          Indicador: "Clases en riesgo (avg < 3, n >= 3)",
          Valor: atRiskClassInsights.length,
        },
        {
          Indicador: "Cursos en riesgo (avg < 3, n >= 3)",
          Valor: atRiskCourseInsights.length,
        },
        {
          Indicador: "Promedio ultimos 14 dias",
          Valor: trendInsight.recentAverage !== null ? trendInsight.recentAverage.toFixed(2) : "N/D",
        },
        {
          Indicador: "Promedio 14 dias previos",
          Valor: trendInsight.previousAverage !== null ? trendInsight.previousAverage.toFixed(2) : "N/D",
        },
        {
          Indicador: "Delta promedio",
          Valor: trendInsight.deltaAverage !== null ? trendInsight.deltaAverage.toFixed(2) : "N/D",
        },
      ];

      const distributionRows = RATING_STARS.map((star) => ({
        Estrellas: star,
        Conteo: evaluationSummary.counts[star],
        Tasa:
          evaluationSummary.total > 0
            ? toRatioPercent(evaluationSummary.counts[star] / evaluationSummary.total)
            : "0.0%",
      }));

      const classRiskRows = topClassRisks.map((item, index) => ({
        Ranking: index + 1,
        Clase: item.classLabel,
        Curso: item.courseLabel,
        Leccion: item.lessonLabel,
        Respuestas: item.responses,
        Promedio: item.average.toFixed(2),
        "Criticas 1-2": toRatioPercent(item.lowRate),
        "Con comentario": toRatioPercent(item.commentsRate),
        Severidad: item.severityScore.toFixed(1),
        "Ultima actualizacion": formatDateTime(item.lastUpdatedAt),
      }));

      const classAllRows = sortedClassInsights.map((item, index) => ({
        Ranking: index + 1,
        Clase: item.classLabel,
        "Class ID": item.classKey,
        Curso: item.courseLabel,
        Leccion: item.lessonLabel,
        Respuestas: item.responses,
        Promedio: item.average.toFixed(2),
        "Criticas 1-2": toRatioPercent(item.lowRate),
        Positivas: toRatioPercent(item.highCount / Math.max(item.responses, 1)),
        "Con comentario": toRatioPercent(item.commentsRate),
        Severidad: item.severityScore.toFixed(1),
        "Ultima actualizacion": formatDateTime(item.lastUpdatedAt),
      }));

      const courseRiskRows = atRiskCourseInsights.map((item, index) => ({
        Ranking: index + 1,
        Curso: item.courseLabel,
        "Course ID": item.courseKey,
        Respuestas: item.responses,
        Promedio: item.average.toFixed(2),
        "Criticas 1-2": toRatioPercent(item.lowRate),
        "Con comentario": toRatioPercent(item.commentsRate),
        Severidad: item.severityScore.toFixed(1),
      }));

      const courseAllRows = sortedCourseInsights.map((item, index) => ({
        Ranking: index + 1,
        Curso: item.courseLabel,
        "Course ID": item.courseKey,
        Respuestas: item.responses,
        Promedio: item.average.toFixed(2),
        "Criticas 1-2": toRatioPercent(item.lowRate),
        Positivas: toRatioPercent(item.highCount / Math.max(item.responses, 1)),
        "Con comentario": toRatioPercent(item.commentsRate),
        Severidad: item.severityScore.toFixed(1),
      }));

      const topicRows = commentTopicInsights.map((topic, index) => ({
        Ranking: index + 1,
        Tema: topic.label,
        Menciones: topic.count,
        Tasa: toRatioPercent(topic.rate),
        Accion: topic.decisionHint,
      }));

      const recommendationRows = recommendations.map((item, index) => ({
        Prioridad: index + 1,
        Recomendacion: item,
      }));

      const evaluationRows = evaluations.map((entry) => ({
        "Fecha actualizacion": formatDateTime(entry.updatedAt),
        "Fecha creacion": formatDateTime(entry.createdAt),
        Curso: entry.courseTitle || entry.courseId || "N/D",
        "Course ID": entry.courseId || "",
        Leccion: entry.lessonTitle || entry.lessonId || "N/D",
        "Lesson ID": entry.lessonId || "",
        Clase: entry.classTitle || entry.classDocId || "N/D",
        "Class ID": entry.classDocId || "",
        Grupo: entry.groupId || "",
        "Enrollment ID": entry.enrollmentId || "",
        "Student ID": entry.studentId || "",
        Estudiante: entry.studentName || "Estudiante",
        Rating: entry.rating,
        Comentario: entry.comment || "",
      }));

      const commentsRows = evaluationsWithComment.map((entry) => ({
        "Fecha actualizacion": formatDateTime(entry.updatedAt),
        Curso: entry.courseTitle || entry.courseId || "N/D",
        Leccion: entry.lessonTitle || entry.lessonId || "N/D",
        Clase: entry.classTitle || entry.classDocId || "N/D",
        Estudiante: entry.studentName || "Estudiante",
        Rating: entry.rating,
        Comentario: entry.comment,
      }));

      const trendDailyMap = new Map<
        string,
        {
          date: string;
          total: number;
          ratingSum: number;
          lowCount: number;
          highCount: number;
          comments: number;
        }
      >();
      evaluations.forEach((entry) => {
        const time = entry.updatedAt?.getTime() ?? entry.createdAt?.getTime();
        if (!time) return;
        const date = new Date(time).toISOString().slice(0, 10);
        const current = trendDailyMap.get(date) ?? {
          date,
          total: 0,
          ratingSum: 0,
          lowCount: 0,
          highCount: 0,
          comments: 0,
        };
        current.total += 1;
        current.ratingSum += entry.rating;
        if (entry.rating <= 2) current.lowCount += 1;
        if (entry.rating >= 4) current.highCount += 1;
        if (entry.comment.trim()) current.comments += 1;
        trendDailyMap.set(date, current);
      });
      const trendDailyRows = Array.from(trendDailyMap.values())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((row) => ({
          Fecha: row.date,
          Evaluaciones: row.total,
          Promedio: (row.ratingSum / Math.max(row.total, 1)).toFixed(2),
          "Criticas 1-2": toRatioPercent(row.lowCount / Math.max(row.total, 1)),
          Positivas: toRatioPercent(row.highCount / Math.max(row.total, 1)),
          "Con comentario": toRatioPercent(row.comments / Math.max(row.total, 1)),
        }));

      const studentMap = new Map<
        string,
        {
          studentId: string;
          studentName: string;
          total: number;
          ratingSum: number;
          lowCount: number;
          comments: number;
          lastUpdatedAt: Date | null;
        }
      >();
      evaluations.forEach((entry) => {
        const key = entry.studentId || `anon-${entry.studentName}`;
        const current = studentMap.get(key) ?? {
          studentId: entry.studentId || "",
          studentName: entry.studentName || "Estudiante",
          total: 0,
          ratingSum: 0,
          lowCount: 0,
          comments: 0,
          lastUpdatedAt: null,
        };
        current.total += 1;
        current.ratingSum += entry.rating;
        if (entry.rating <= 2) current.lowCount += 1;
        if (entry.comment.trim()) current.comments += 1;
        if ((entry.updatedAt?.getTime() ?? 0) > (current.lastUpdatedAt?.getTime() ?? 0)) {
          current.lastUpdatedAt = entry.updatedAt ?? current.lastUpdatedAt;
        }
        studentMap.set(key, current);
      });
      const studentRows = Array.from(studentMap.values())
        .sort((a, b) => b.total - a.total)
        .map((row) => ({
          "Student ID": row.studentId || "",
          Estudiante: row.studentName,
          Evaluaciones: row.total,
          Promedio: (row.ratingSum / Math.max(row.total, 1)).toFixed(2),
          "Criticas 1-2": toRatioPercent(row.lowCount / Math.max(row.total, 1)),
          "Con comentario": toRatioPercent(row.comments / Math.max(row.total, 1)),
          "Ultima evaluacion": formatDateTime(row.lastUpdatedAt),
        }));

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Resumen");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(distributionRows), "Distribucion");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(classRiskRows), "Clases_TopRiesgo");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(classAllRows), "Clases_Todas");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(courseRiskRows), "Cursos_Riesgo");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(courseAllRows), "Cursos_Todos");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(trendDailyRows), "Tendencia_Diaria");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(studentRows), "Estudiantes");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(topicRows), "Temas");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(recommendationRows), "Recomendaciones");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(commentsRows), "Comentarios");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(evaluationRows), "Evaluaciones");

      const dateToken = new Date().toISOString().slice(0, 10);
      const safeCourseToken = (evaluationsCourseFilter.trim() || "todos")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
      XLSX.writeFile(workbook, `reporte-evaluaciones-${safeCourseToken || "todos"}-${dateToken}.xlsx`);
      toast.success("Reporte Excel generado.");
    } catch (error) {
      console.error("No se pudo generar el Excel de analitica:", error);
      toast.error("No se pudo generar el Excel. Intenta de nuevo.");
    } finally {
      setEvaluationsExcelLoading(false);
    }
  }, [
    atRiskClassInsights.length,
    atRiskCourseInsights,
    classInsights,
    commentTopicInsights,
    courseInsights,
    commentsRate,
    evaluationSummary,
    evaluations,
    evaluationsCourseFilter,
    evaluationsEndDate,
    evaluationsStartDate,
    evaluationsWithComment,
    highRatingCount,
    lowRatingCount,
    lowRatingRate,
    trendInsight,
    worstClassInsights,
  ]);

  const handleDownloadSurveyReportPdf = useCallback(
    async (survey: SatisfactionSurvey) => {
      const surveyId = survey.id.trim();
      if (!surveyId) return;

      setSurveyPdfLoadingId(surveyId);
      try {
        const responses = await getOrLoadResponsesForSurvey(surveyId);
        const questionInsights = buildSurveyQuestionInsights(survey, responses);
        const ratingInsights = questionInsights.filter(
          (item): item is SurveyQuestionInsight & { average: number; lowRate: number; severityScore: number } =>
            item.type === "rating_1_5" &&
            typeof item.average === "number" &&
            typeof item.lowRate === "number" &&
            typeof item.severityScore === "number",
        );
        const riskyRatingQuestions = ratingInsights
          .filter((item) => item.answeredCount >= REPORT_MIN_SAMPLE)
          .sort((a, b) => {
            if (b.severityScore !== a.severityScore) return b.severityScore - a.severityScore;
            return a.average - b.average;
          })
          .slice(0, 8);

        const allRatingValues = responses.flatMap((response) =>
          survey.questions
            .filter((question) => question.type === "rating_1_5")
            .map((question) => toValidRating(getAnswerValue(response, question.id)))
            .filter((value): value is number => value !== null),
        );
        const globalAverage =
          allRatingValues.length > 0
            ? roundTo2(allRatingValues.reduce((sum, value) => sum + value, 0) / allRatingValues.length)
            : null;
        const globalLowRate =
          allRatingValues.length > 0
            ? allRatingValues.filter((value) => value <= 2).length / allRatingValues.length
            : null;

        const totalPotentialAnswers = responses.length * Math.max(survey.questions.length, 1);
        const totalAnswered = questionInsights.reduce((sum, item) => sum + item.answeredCount, 0);
        const completionRate = totalPotentialAnswers > 0 ? totalAnswered / totalPotentialAnswers : 0;

        const criticalComments = buildSurveyCriticalCommentRows(survey, responses);
        const topTextTopics = questionInsights
          .filter((item) => item.type === "text" && item.topTopics && item.topTopics.length > 0)
          .flatMap((item) => item.topTopics ?? [])
          .reduce<Record<string, { label: string; count: number }>>((acc, topic) => {
            const key = topic.label;
            acc[key] = {
              label: topic.label,
              count: (acc[key]?.count ?? 0) + topic.count,
            };
            return acc;
          }, {});
        const topTopics = Object.values(topTextTopics)
          .map((topic) => ({
            label: topic.label,
            count: topic.count,
            rate: responses.length > 0 ? topic.count / responses.length : 0,
          }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 6);

        const recommendations: string[] = [];
        if (globalLowRate !== null && globalLowRate >= 0.25) {
          recommendations.push(
            `La tasa de respuestas criticas (1-2) es ${toRatioPercent(
              globalLowRate,
            )}; activar plan correctivo para esta encuesta.`,
          );
        }
        if (riskyRatingQuestions.length > 0) {
          recommendations.push(
            `Priorizar la mejora de la pregunta "${riskyRatingQuestions[0].label}" (promedio ${riskyRatingQuestions[0].average.toFixed(
              2,
            )}).`,
          );
        }
        if (topTopics.length > 0) {
          recommendations.push(
            `Tema recurrente principal: "${topTopics[0].label}" (${topTopics[0].count} menciones). Planear accion especifica.`,
          );
        }
        if (completionRate < 0.75) {
          recommendations.push(
            `La completitud de respuestas es ${toRatioPercent(
              completionRate,
            )}; revisar longitud o claridad de preguntas para mejorar calidad de datos.`,
          );
        }
        if (!recommendations.length) {
          recommendations.push(
            "No se detectan focos rojos severos; mantener monitoreo y comparar contra la siguiente cohorte.",
          );
        }

        const { jsPDF } = await import("jspdf");
        const pdf = new jsPDF({ unit: "pt", format: "a4" });
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const marginX = 40;
        const topMargin = 46;
        const bottomMargin = 42;
        const contentWidth = pageWidth - marginX * 2;
        const bottomLimit = pageHeight - bottomMargin;
        let y = topMargin;

        const ensureSpace = (requiredHeight: number) => {
          if (y + requiredHeight <= bottomLimit) return;
          pdf.addPage();
          y = topMargin;
        };

        const drawTitle = (text: string) => {
          ensureSpace(30);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(18);
          pdf.setTextColor(15, 23, 42);
          pdf.text(text, marginX, y);
          y += 22;
        };

        const drawSection = (text: string) => {
          ensureSpace(24);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(13);
          pdf.setTextColor(30, 41, 59);
          pdf.text(text, marginX, y);
          y += 16;
        };

        const drawParagraph = (
          text: string,
          fontSize = 10,
          color: [number, number, number] = [71, 85, 105],
        ) => {
          pdf.setFont("helvetica", "normal");
          pdf.setFontSize(fontSize);
          pdf.setTextColor(color[0], color[1], color[2]);
          const lines = pdf.splitTextToSize(text, contentWidth) as string[];
          ensureSpace(lines.length * 13 + 4);
          pdf.text(lines, marginX, y);
          y += lines.length * 13 + 4;
        };

        const drawKeyValue = (label: string, value: string) => {
          ensureSpace(14);
          pdf.setFont("helvetica", "bold");
          pdf.setFontSize(10);
          pdf.setTextColor(30, 41, 59);
          pdf.text(label, marginX, y);
          pdf.setFont("helvetica", "normal");
          pdf.setTextColor(51, 65, 85);
          pdf.text(value, marginX + 210, y);
          y += 14;
        };

        drawTitle("Reporte por encuesta");
        drawParagraph(`Encuesta: ${survey.title}`, 11);
        drawParagraph(`Generado: ${new Date().toLocaleString("es-MX")}`);
        drawParagraph(`Estado: ${STATUS_LABELS[survey.status]} • Segmento: ${SEGMENT_LABELS[survey.segment]}`);
        drawParagraph(
          `Incluye alumnos futuros: ${
            survey.applyToFutureStudents ? "Si" : "No"
          } • Ultima actualizacion: ${formatDateTime(survey.updatedAt)}`,
        );
        y += 4;

        drawSection("1) Resumen ejecutivo");
        drawKeyValue("Total de respuestas", String(responses.length));
        drawKeyValue("Preguntas en encuesta", String(survey.questions.length));
        drawKeyValue("Completitud general", toRatioPercent(completionRate));
        drawKeyValue("Promedio global (preguntas 1-5)", globalAverage !== null ? globalAverage.toFixed(2) : "N/D");
        drawKeyValue(
          "Tasa critica 1-2 (preguntas 1-5)",
          globalLowRate !== null ? toRatioPercent(globalLowRate) : "N/D",
        );
        drawKeyValue("Comentarios de texto analizados", String(criticalComments.length));

        y += 4;
        drawSection("2) Preguntas de mayor riesgo");
        if (!riskyRatingQuestions.length) {
          drawParagraph("No hay preguntas de escala con muestra suficiente para determinar riesgo.");
        } else {
          riskyRatingQuestions.forEach((item, index) => {
            drawParagraph(
              `${index + 1}. ${item.label} | promedio ${item.average.toFixed(2)} | criticas ${toRatioPercent(
                item.lowRate,
              )} | severidad ${item.severityScore.toFixed(1)}/100`,
            );
          });
        }

        y += 4;
        drawSection("3) Resultado por pregunta");
        questionInsights.forEach((item, index) => {
          drawParagraph(
            `${index + 1}. ${item.label} (${item.type}) - respondidas ${item.answeredCount}, sin respuesta ${item.missingCount}`,
            10,
            [30, 41, 59],
          );
          if (item.type === "rating_1_5") {
            drawParagraph(
              `Promedio ${item.average?.toFixed(2) ?? "N/D"} | criticas ${toRatioPercent(
                item.lowRate ?? 0,
              )} | severidad ${(item.severityScore ?? 0).toFixed(1)}/100`,
            );
          } else if (item.type === "single_choice") {
            const topOptions = (item.optionsSummary ?? []).slice(0, 3);
            if (!topOptions.length) {
              drawParagraph("Sin respuestas de opcion multiple.");
            } else {
              topOptions.forEach((option, optionIndex) => {
                drawParagraph(
                  `Opcion ${optionIndex + 1}: ${option.option} (${option.count}, ${toRatioPercent(option.rate)})`,
                );
              });
            }
          } else {
            const topicText = (item.topTopics ?? [])
              .slice(0, 3)
              .map((topic) => `${topic.label}: ${topic.count} (${toRatioPercent(topic.rate)})`)
              .join(" | ");
            drawParagraph(topicText || "Sin temas recurrentes detectables en texto.");
          }
          y += 2;
        });

        y += 4;
        drawSection("4) Comentarios prioritarios (para accion)");
        if (!criticalComments.length) {
          drawParagraph("No hay comentarios de texto para priorizar en esta encuesta.");
        } else {
          criticalComments.forEach((row, index) => {
            drawParagraph(
              `${index + 1}. ${row.studentName} ${
                row.studentEmail ? `(${row.studentEmail})` : ""
              } | rating global ${row.overallRating?.toFixed(2) ?? "N/D"} | ${formatDateTime(row.submittedAt)}`,
            );
            drawParagraph(`"${truncateText(row.comment, 220)}"`);
          });
        }

        y += 4;
        drawSection("5) Recomendaciones accionables");
        recommendations.forEach((item, index) => {
          drawParagraph(`${index + 1}. ${item}`);
        });

        y += 8;
        drawParagraph("Documento generado automaticamente por Plataforma UDEL.", 9, [100, 116, 139]);

        const stamp = new Date().toISOString().slice(0, 10);
        const safeTitle = survey.title
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase();
        pdf.save(`reporte-encuesta-${safeTitle || surveyId}-${stamp}.pdf`);
      } catch (error) {
        console.error("No se pudo generar el reporte PDF de encuesta:", error);
        toast.error("No se pudo generar el reporte PDF de la encuesta.");
      } finally {
        setSurveyPdfLoadingId(null);
      }
    },
    [getOrLoadResponsesForSurvey],
  );

  const handleDownloadSurveyReportExcel = useCallback(
    async (survey: SatisfactionSurvey) => {
      const surveyId = survey.id.trim();
      if (!surveyId) return;

      setSurveyExcelLoadingId(surveyId);
      try {
        const responses = await getOrLoadResponsesForSurvey(surveyId);
        const questionInsights = buildSurveyQuestionInsights(survey, responses);

        const allRatingValues = responses.flatMap((response) =>
          survey.questions
            .filter((question) => question.type === "rating_1_5")
            .map((question) => toValidRating(getAnswerValue(response, question.id)))
            .filter((value): value is number => value !== null),
        );
        const globalAverage =
          allRatingValues.length > 0
            ? roundTo2(allRatingValues.reduce((sum, value) => sum + value, 0) / allRatingValues.length)
            : null;
        const globalLowRate =
          allRatingValues.length > 0
            ? allRatingValues.filter((value) => value <= 2).length / allRatingValues.length
            : null;

        const totalPotentialAnswers = responses.length * Math.max(survey.questions.length, 1);
        const totalAnswered = questionInsights.reduce((sum, item) => sum + item.answeredCount, 0);
        const completionRate = totalPotentialAnswers > 0 ? totalAnswered / totalPotentialAnswers : 0;

        const summaryRows = [
          { Indicador: "Encuesta", Valor: survey.title },
          { Indicador: "Survey ID", Valor: survey.id },
          { Indicador: "Estado", Valor: STATUS_LABELS[survey.status] },
          { Indicador: "Segmento", Valor: SEGMENT_LABELS[survey.segment] },
          { Indicador: "Incluye alumnos futuros", Valor: survey.applyToFutureStudents ? "Si" : "No" },
          { Indicador: "Respuestas", Valor: responses.length },
          { Indicador: "Preguntas", Valor: survey.questions.length },
          { Indicador: "Completitud general", Valor: toRatioPercent(completionRate) },
          {
            Indicador: "Promedio global (1-5)",
            Valor: globalAverage !== null ? globalAverage.toFixed(2) : "N/D",
          },
          {
            Indicador: "Tasa critica 1-2 (1-5)",
            Valor: globalLowRate !== null ? toRatioPercent(globalLowRate) : "N/D",
          },
          { Indicador: "Generado", Valor: new Date().toLocaleString("es-MX") },
        ];

        const questionsRows = questionInsights.map((item, index) => ({
          Orden: index + 1,
          Pregunta: item.label,
          Tipo: item.type,
          Respondidas: item.answeredCount,
          "Sin respuesta": item.missingCount,
          "Promedio (1-5)": item.type === "rating_1_5" ? item.average?.toFixed(2) ?? "N/D" : "N/A",
          "Criticas 1-2": item.type === "rating_1_5" ? toRatioPercent(item.lowRate ?? 0) : "N/A",
          Severidad: item.type === "rating_1_5" ? (item.severityScore ?? 0).toFixed(1) : "N/A",
          "Top opciones": (item.optionsSummary ?? [])
            .slice(0, 3)
            .map((option) => `${option.option} (${option.count}, ${toRatioPercent(option.rate)})`)
            .join(" | "),
          "Top temas texto": (item.topTopics ?? [])
            .slice(0, 3)
            .map((topic) => `${topic.label} (${topic.count}, ${toRatioPercent(topic.rate)})`)
            .join(" | "),
        }));

        const responseRows = responses.map((response, index) => {
          const row: Record<string, string | number> = {
            Folio: index + 1,
            "Response ID": response.id,
            "Student ID": response.studentId || "",
            Estudiante: response.studentName || "Estudiante",
            Correo: response.studentEmail || "",
            "Fecha envio": formatDateTime(response.submittedAt),
          };
          survey.questions.forEach((question, questionIndex) => {
            const answer = getAnswerValue(response, question.id);
            row[`P${questionIndex + 1} - ${question.label}`] =
              answer === null || String(answer).trim() === "" ? "Sin respuesta" : String(answer);
          });
          return row;
        });

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Resumen");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(questionsRows), "Preguntas");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(responseRows), "Respuestas");

        const stamp = new Date().toISOString().slice(0, 10);
        const safeTitle = survey.title
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase();

        XLSX.writeFile(workbook, `reporte-encuesta-${safeTitle || surveyId}-${stamp}.xlsx`);
        toast.success("Reporte Excel generado.");
      } catch (error) {
        console.error("No se pudo generar el reporte Excel de encuesta:", error);
        toast.error("No se pudo generar el reporte Excel de la encuesta.");
      } finally {
        setSurveyExcelLoadingId(null);
      }
    },
    [getOrLoadResponsesForSurvey],
  );

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
          status: form.enabled ? "published" : "draft",
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
          status: form.enabled ? "published" : "draft",
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
      enabled: survey.status === "published",
      segment: survey.segment,
      applyToFutureStudents: survey.applyToFutureStudents,
      questions: survey.questions.length ? survey.questions : [buildQuestion("rating_1_5")],
    });
  };

  const handleToggleSurveyEnabled = async (survey: SatisfactionSurvey, enabled: boolean) => {
    await handleChangeSurveyStatus(survey.id, enabled ? "published" : "draft");
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

              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        enabled: event.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Encuesta activa
                </label>
                <p className="mt-1 text-xs text-slate-600">
                  Por defecto queda desactivada (borrador). Actívala cuando quieras publicarla.
                </p>
              </div>

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
                    <button
                      type="button"
                      onClick={() => void handleDownloadSurveyReportPdf(survey)}
                      disabled={surveyPdfLoadingId === survey.id}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {surveyPdfLoadingId === survey.id ? "Generando PDF..." : "Reporte PDF"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadSurveyReportExcel(survey)}
                      disabled={surveyExcelLoadingId === survey.id}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {surveyExcelLoadingId === survey.id ? "Generando Excel..." : "Reporte Excel"}
                    </button>

                    {canManageSurveys ? (
                      <>
                        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">
                          <input
                            type="checkbox"
                            checked={survey.status === "published"}
                            onChange={(event) =>
                              void handleToggleSurveyEnabled(survey, event.target.checked)
                            }
                            disabled={statusUpdatingId === survey.id}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          {survey.status === "published" ? "Activa" : "Desactivada"}
                        </label>
                        <button
                          type="button"
                          onClick={() => handleEditSurvey(survey)}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700"
                        >
                          Editar
                        </button>
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
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void loadClassEvaluationsData()}
                disabled={evaluationsLoading}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {evaluationsLoading ? "Cargando..." : "Aplicar filtros"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadEvaluationsReportPdf()}
                disabled={evaluationsPdfLoading || evaluations.length === 0}
                className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {evaluationsPdfLoading ? "Generando PDF..." : "Descargar reporte PDF"}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadEvaluationsReportExcel()}
                disabled={evaluationsExcelLoading || evaluations.length === 0}
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:border-emerald-300 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {evaluationsExcelLoading ? "Generando Excel..." : "Descargar reporte Excel"}
              </button>
            </div>
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

          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <MetricCard
              title="Clases en riesgo"
              value={String(atRiskClassInsights.length)}
              subtitle="avg < 3.0 y muestra >= 3"
            />
            <MetricCard
              title="Cursos en riesgo"
              value={String(atRiskCourseInsights.length)}
              subtitle="avg < 3.0 y muestra >= 3"
            />
            <MetricCard
              title="Criticas (1-2★)"
              value={toRatioPercent(lowRatingRate)}
              subtitle={`${lowRatingCount} evaluaciones`}
            />
            <MetricCard
              title="Cobertura comentario"
              value={toRatioPercent(commentsRate)}
              subtitle={`${evaluationsWithComment.length} comentarios`}
            />
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-5">
            {RATING_STARS.map((star) => (
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

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <h3 className="text-sm font-semibold text-slate-800">Top clases/contenidos en riesgo</h3>
              {worstClassInsights.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">Aun no hay muestra suficiente para ranking.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {worstClassInsights.slice(0, 6).map((item, index) => (
                    <article key={item.classKey} className="rounded-lg border border-slate-200 bg-white p-2.5">
                      <p className="text-sm font-semibold text-slate-900">
                        {index + 1}. {item.classLabel}
                      </p>
                      <p className="text-xs text-slate-500">
                        {item.courseLabel} • {item.responses} evals • promedio {item.average.toFixed(2)}
                      </p>
                      <p className="text-xs text-rose-700">
                        Criticas: {toRatioPercent(item.lowRate)} • Severidad: {item.severityScore.toFixed(1)}/100
                      </p>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <h3 className="text-sm font-semibold text-slate-800">Temas que mas impactan la satisfaccion</h3>
              {commentTopicInsights.length === 0 ? (
                <p className="mt-2 text-sm text-slate-600">No hay suficientes comentarios para clasificar temas.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {commentTopicInsights.slice(0, 6).map((topic) => (
                    <article key={topic.id} className="rounded-lg border border-slate-200 bg-white p-2.5">
                      <p className="text-sm font-semibold text-slate-900">{topic.label}</p>
                      <p className="text-xs text-slate-500">
                        {topic.count} menciones ({toRatioPercent(topic.rate)})
                      </p>
                      <p className="text-xs text-slate-700">{topic.decisionHint}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
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
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleDownloadSurveyReportPdf(selectedSurvey)}
                  disabled={surveyPdfLoadingId === selectedSurvey.id}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {surveyPdfLoadingId === selectedSurvey.id ? "Generando PDF..." : "Reporte PDF"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDownloadSurveyReportExcel(selectedSurvey)}
                  disabled={surveyExcelLoadingId === selectedSurvey.id}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {surveyExcelLoadingId === selectedSurvey.id ? "Generando Excel..." : "Reporte Excel"}
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedSurveyId(null)}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300"
                >
                  Cerrar
                </button>
              </div>
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

function MetricCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{title}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
      {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
    </div>
  );
}
