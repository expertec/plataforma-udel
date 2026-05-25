export type TeacherProfessionalProfile = {
  headline: string;
  bio: string;
  strengths: string[];
  expertiseTopics: string[];
  certifications: string[];
};

export type TeacherEvaluationTopicInsight = {
  id: string;
  label: string;
  count: number;
  rate: number;
};

export type TeacherCourseRatingInsight = {
  courseLabel: string;
  responses: number;
  average: number;
  lowRate: number;
};

export type TeacherEvaluationSummary = {
  total: number;
  average: number;
  highCount: number;
  lowCount: number;
  commentsCount: number;
  positiveRate: number;
  lowRate: number;
  lastUpdatedAt: Date | null;
};

export type TeacherCvSnapshot = {
  profile: TeacherProfessionalProfile;
  evaluationSummary: TeacherEvaluationSummary;
  strengthsFromFeedback: TeacherEvaluationTopicInsight[];
  improvementAreas: TeacherEvaluationTopicInsight[];
  topRatedCourses: TeacherCourseRatingInsight[];
  taughtCourseNames: string[];
  dominantPrograms: string[];
};

type TeacherEvaluationLike = {
  rating: number;
  comment?: string | null;
  updatedAt?: Date | null;
  courseTitle?: string | null;
  courseId?: string | null;
};

type TeacherWorkloadCourseDetailLike = {
  courseName?: string | null;
  groupsCount?: number | null;
};

type TeacherWorkloadProgramLike = {
  program?: string | null;
  courses?: number | null;
};

type TeacherWorkloadLike = {
  courseDetails?: TeacherWorkloadCourseDetailLike[] | null;
  programBreakdown?: TeacherWorkloadProgramLike[] | null;
};

type TopicRule = {
  id: string;
  label: string;
  keywords: string[];
};

const EMPTY_PROFILE: TeacherProfessionalProfile = {
  headline: "",
  bio: "",
  strengths: [],
  expertiseTopics: [],
  certifications: [],
};

const POSITIVE_TOPIC_RULES: TopicRule[] = [
  {
    id: "clarity",
    label: "Claridad para explicar",
    keywords: ["claro", "claridad", "explica", "entendi", "entender", "didact"],
  },
  {
    id: "domain",
    label: "Dominio del tema",
    keywords: ["domina", "dominio", "experto", "conoce", "sabe", "preparad"],
  },
  {
    id: "support",
    label: "Acompanamiento al alumno",
    keywords: ["apoyo", "ayuda", "acompan", "seguimiento", "responde", "atento"],
  },
  {
    id: "practical",
    label: "Ejemplos practicos",
    keywords: ["ejemplo", "practico", "caso real", "aplicado", "dinamica"],
  },
  {
    id: "engagement",
    label: "Participacion y dinamica",
    keywords: ["particip", "interactivo", "interesante", "ameno", "dinamic"],
  },
];

const IMPROVEMENT_TOPIC_RULES: TopicRule[] = [
  {
    id: "clarity",
    label: "Claridad de explicacion",
    keywords: ["confus", "claro", "explica", "duda", "entender"],
  },
  {
    id: "pace",
    label: "Ritmo y carga",
    keywords: ["rapido", "lento", "tiempo", "carga", "pesad", "demasiado"],
  },
  {
    id: "difficulty",
    label: "Dificultad del contenido",
    keywords: ["dificil", "complej", "complicad", "no entiendo"],
  },
  {
    id: "material",
    label: "Materiales y recursos",
    keywords: ["material", "recurso", "pdf", "diaposit", "guia", "ejemplo"],
  },
  {
    id: "feedback",
    label: "Retroalimentacion y evaluacion",
    keywords: ["retroaliment", "calific", "rubrica", "seguimiento"],
  },
];

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function roundTo2(value: number): number {
  return Number(value.toFixed(2));
}

function toUniqueTextList(values: string[]): string[] {
  const unique = new Set<string>();
  values.forEach((value) => {
    const normalized = normalizeText(value);
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique);
}

export function normalizeTeacherProfileTextList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return toUniqueTextList(
      value.filter((item): item is string => typeof item === "string"),
    );
  }
  if (typeof value === "string") {
    return toUniqueTextList(
      value
        .split(/\r?\n|,|;/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return [];
}

export function normalizeTeacherProfessionalProfile(
  value: unknown,
): TeacherProfessionalProfile {
  if (!value || typeof value !== "object") return { ...EMPTY_PROFILE };
  const candidate = value as Record<string, unknown>;
  return {
    headline: normalizeText(candidate.headline),
    bio: normalizeText(candidate.bio),
    strengths: normalizeTeacherProfileTextList(candidate.strengths),
    expertiseTopics: normalizeTeacherProfileTextList(candidate.expertiseTopics),
    certifications: normalizeTeacherProfileTextList(candidate.certifications),
  };
}

function buildEvaluationSummary(
  evaluations: TeacherEvaluationLike[],
): TeacherEvaluationSummary {
  if (evaluations.length === 0) {
    return {
      total: 0,
      average: 0,
      highCount: 0,
      lowCount: 0,
      commentsCount: 0,
      positiveRate: 0,
      lowRate: 0,
      lastUpdatedAt: null,
    };
  }

  let ratingSum = 0;
  let highCount = 0;
  let lowCount = 0;
  let commentsCount = 0;
  let lastUpdatedAt: Date | null = null;

  evaluations.forEach((evaluation) => {
    ratingSum += evaluation.rating;
    if (evaluation.rating >= 4) highCount += 1;
    if (evaluation.rating <= 2) lowCount += 1;
    if (normalizeText(evaluation.comment).length > 0) commentsCount += 1;
    if (
      evaluation.updatedAt &&
      (!lastUpdatedAt || evaluation.updatedAt.getTime() > lastUpdatedAt.getTime())
    ) {
      lastUpdatedAt = evaluation.updatedAt;
    }
  });

  return {
    total: evaluations.length,
    average: roundTo2(ratingSum / evaluations.length),
    highCount,
    lowCount,
    commentsCount,
    positiveRate: highCount / evaluations.length,
    lowRate: lowCount / evaluations.length,
    lastUpdatedAt,
  };
}

function buildTopicInsights(
  evaluations: TeacherEvaluationLike[],
  rules: TopicRule[],
): TeacherEvaluationTopicInsight[] {
  if (evaluations.length === 0) return [];

  const counts = new Map<string, number>();
  rules.forEach((rule) => counts.set(rule.id, 0));

  evaluations.forEach((evaluation) => {
    const comment = normalizeForSearch(normalizeText(evaluation.comment));
    if (!comment) return;
    rules.forEach((rule) => {
      if (rule.keywords.some((keyword) => comment.includes(keyword))) {
        counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      }
    });
  });

  return rules
    .map((rule) => {
      const count = counts.get(rule.id) ?? 0;
      return {
        id: rule.id,
        label: rule.label,
        count,
        rate: evaluations.length > 0 ? count / evaluations.length : 0,
      };
    })
    .filter((item) => item.count > 0)
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label, "es");
    });
}

function buildTopRatedCourses(
  evaluations: TeacherEvaluationLike[],
): TeacherCourseRatingInsight[] {
  const map = new Map<
    string,
    {
      courseLabel: string;
      responses: number;
      ratingSum: number;
      lowCount: number;
    }
  >();

  evaluations.forEach((evaluation) => {
    const courseLabel =
      normalizeText(evaluation.courseTitle) ||
      normalizeText(evaluation.courseId) ||
      "Curso";
    const current = map.get(courseLabel) ?? {
      courseLabel,
      responses: 0,
      ratingSum: 0,
      lowCount: 0,
    };
    current.responses += 1;
    current.ratingSum += evaluation.rating;
    if (evaluation.rating <= 2) current.lowCount += 1;
    map.set(courseLabel, current);
  });

  return Array.from(map.values())
    .map((item) => ({
      courseLabel: item.courseLabel,
      responses: item.responses,
      average: roundTo2(item.ratingSum / item.responses),
      lowRate: item.responses > 0 ? item.lowCount / item.responses : 0,
    }))
    .sort((left, right) => {
      if (right.average !== left.average) return right.average - left.average;
      if (right.responses !== left.responses) return right.responses - left.responses;
      return left.courseLabel.localeCompare(right.courseLabel, "es");
    })
    .slice(0, 5);
}

function buildTaughtCourseNames(workload: TeacherWorkloadLike | null | undefined): string[] {
  if (!workload?.courseDetails?.length) return [];
  return toUniqueTextList(
    [...workload.courseDetails]
      .sort((left, right) => (right.groupsCount ?? 0) - (left.groupsCount ?? 0))
      .map((course) => normalizeText(course.courseName))
      .filter(Boolean),
  ).slice(0, 8);
}

function buildDominantPrograms(workload: TeacherWorkloadLike | null | undefined): string[] {
  if (!workload?.programBreakdown?.length) return [];
  return toUniqueTextList(
    [...workload.programBreakdown]
      .sort((left, right) => (right.courses ?? 0) - (left.courses ?? 0))
      .map((program) => normalizeText(program.program))
      .filter((value) => value && value.toLowerCase() !== "sin programa"),
  ).slice(0, 6);
}

export function buildTeacherCvSnapshot(params: {
  profile: unknown;
  evaluations?: TeacherEvaluationLike[] | null;
  workload?: TeacherWorkloadLike | null;
}): TeacherCvSnapshot {
  const profile = normalizeTeacherProfessionalProfile(params.profile);
  const evaluations = Array.isArray(params.evaluations) ? params.evaluations : [];
  const positiveEvaluations = evaluations.filter(
    (evaluation) => evaluation.rating >= 4 && normalizeText(evaluation.comment).length > 0,
  );
  const negativeEvaluations = evaluations.filter(
    (evaluation) => evaluation.rating <= 2 && normalizeText(evaluation.comment).length > 0,
  );

  return {
    profile,
    evaluationSummary: buildEvaluationSummary(evaluations),
    strengthsFromFeedback: buildTopicInsights(positiveEvaluations, POSITIVE_TOPIC_RULES),
    improvementAreas: buildTopicInsights(negativeEvaluations, IMPROVEMENT_TOPIC_RULES),
    topRatedCourses: buildTopRatedCourses(evaluations),
    taughtCourseNames: buildTaughtCourseNames(params.workload),
    dominantPrograms: buildDominantPrograms(params.workload),
  };
}
