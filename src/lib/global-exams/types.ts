export const GLOBAL_EXAM_MIN_QUESTIONS = 1;
export const GLOBAL_EXAM_MAX_QUESTIONS = 25;
export const GLOBAL_EXAM_PASS_SCORE = 70;
export const GLOBAL_EXAM_DURATION_MINUTES = 40;
// Cada habilitación otorga un único intento. Si el alumno lo usa (apruebe o repruebe)
// queda bloqueado hasta que un adminTeacher vuelva a habilitar el examen, lo que
// concede exactamente un intento adicional.
export const GLOBAL_EXAM_MAX_ATTEMPTS = 1;
export const GLOBAL_EXAM_OPTION_COUNT = 4;

export type GlobalExamTemplateStatus = "draft" | "published";
export type GlobalExamAssignmentStatus = "draft" | "enabled" | "passed" | "failed" | "disabled";
export type GlobalExamAssignmentReason = "failed_course" | "late_joiner";
export type GlobalExamAttemptCompletionReason =
  | "submitted"
  | "timeout"
  | "visibility_change"
  | "page_exit";

export type GlobalExamQuestionOption = {
  id: string;
  text: string;
};

export type GlobalExamQuestion = {
  id: string;
  prompt: string;
  options: GlobalExamQuestionOption[];
  correctOptionId: string;
};

export type StudentVisibleGlobalExamQuestion = Omit<GlobalExamQuestion, "correctOptionId">;

export type GlobalExamTemplateRecord = {
  id: string;
  title: string;
  description: string;
  status: GlobalExamTemplateStatus;
  courseId: string;
  courseName: string;
  passScore: number;
  maxAttempts: number;
  questionCount: number;
  questions: GlobalExamQuestion[];
  createdById: string;
  createdByName: string;
  updatedById: string;
  updatedByName: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GlobalExamAssignmentRecord = {
  id: string;
  templateId: string;
  templateTitle: string;
  courseId: string;
  courseName: string;
  groupId: string;
  groupName: string;
  plantelId: string;
  plantelName: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  reason: GlobalExamAssignmentReason;
  enabled: boolean;
  status: GlobalExamAssignmentStatus;
  attemptsAllowed: number;
  attemptsUsed: number;
  passScore: number;
  latestScore: number | null;
  bestScore: number | null;
  latestAttemptNumber: number;
  latestAttemptId: string | null;
  latestAttemptDurationSeconds: number | null;
  passed: boolean;
  currentAttemptStartedAt?: string | null;
  currentAttemptDeadlineAt?: string | null;
  paymentVerifiedAt?: string | null;
  enabledAt?: string | null;
  enabledById?: string | null;
  enabledByName?: string | null;
  createdById: string;
  createdByName: string;
  updatedById: string;
  updatedByName: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type GlobalExamAttemptRecord = {
  id: string;
  assignmentId: string;
  attemptNumber: number;
  score: number;
  passed: boolean;
  correctAnswers: number;
  totalQuestions: number;
  answers: Record<string, string>;
  durationSeconds?: number | null;
  completionReason?: GlobalExamAttemptCompletionReason | null;
  startedAt?: string | null;
  deadlineAt?: string | null;
  submittedAt?: string | null;
};

export type GlobalExamAttemptSummary = {
  attemptNumber: number;
  score: number;
  passed: boolean;
  durationSeconds?: number | null;
  submittedAt?: string | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionText(value: unknown): string {
  return asTrimmedString(value).replace(/\s+/g, " ");
}

function normalizeQuestionId(value: unknown, index: number): string {
  const direct = asTrimmedString(value);
  if (direct) return direct;
  return `question_${index + 1}`;
}

function normalizeOptionId(value: unknown, index: number): string {
  const direct = asTrimmedString(value);
  if (direct) return direct;
  return `option_${index + 1}`;
}

export function getGlobalExamReasonLabel(reason: GlobalExamAssignmentReason): string {
  return reason === "late_joiner" ? "Alumno regularizando ingreso tardio" : "Alumno reprobado";
}

export function getGlobalExamStatusLabel(status: GlobalExamAssignmentStatus): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "enabled":
      return "Habilitado";
    case "passed":
      return "Aprobado";
    case "failed":
      return "Reprobado";
    case "disabled":
      return "Deshabilitado";
    default:
      return status;
  }
}

export function getGlobalExamTemplateStatusLabel(status: GlobalExamTemplateStatus): string {
  return status === "published" ? "Publicado" : "Borrador";
}

export function getGlobalExamCourseLabel(courseName: string): string {
  const normalized = courseName.trim();
  return normalized || "Sin materia";
}

export function sanitizeGlobalExamQuestionsForStudent(
  questions: GlobalExamQuestion[],
): StudentVisibleGlobalExamQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    options: question.options,
  }));
}

export function roundGlobalExamScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.round(score * 10) / 10;
}

export function normalizeGlobalExamQuestions(value: unknown): GlobalExamQuestion[] {
  if (!Array.isArray(value)) {
    throw new Error("Debes enviar un arreglo de preguntas");
  }

  if (value.length < GLOBAL_EXAM_MIN_QUESTIONS || value.length > GLOBAL_EXAM_MAX_QUESTIONS) {
    throw new Error(
      `El examen debe tener entre ${GLOBAL_EXAM_MIN_QUESTIONS} y ${GLOBAL_EXAM_MAX_QUESTIONS} preguntas`,
    );
  }

  return value.map((rawQuestion, questionIndex) => {
    if (!rawQuestion || typeof rawQuestion !== "object" || Array.isArray(rawQuestion)) {
      throw new Error(`La pregunta ${questionIndex + 1} es invalida`);
    }

    const question = rawQuestion as {
      id?: unknown;
      prompt?: unknown;
      options?: unknown;
      correctOptionId?: unknown;
    };
    const prompt = asTrimmedString(question.prompt).replace(/\s+/g, " ");
    if (!prompt) {
      throw new Error(`La pregunta ${questionIndex + 1} debe incluir un enunciado`);
    }

    if (!Array.isArray(question.options) || question.options.length !== GLOBAL_EXAM_OPTION_COUNT) {
      throw new Error(
        `La pregunta ${questionIndex + 1} debe incluir exactamente ${GLOBAL_EXAM_OPTION_COUNT} opciones`,
      );
    }

    const options = question.options.map((rawOption, optionIndex) => {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
        throw new Error(`La opcion ${optionIndex + 1} de la pregunta ${questionIndex + 1} es invalida`);
      }

      const option = rawOption as { id?: unknown; text?: unknown };
      const text = normalizeOptionText(option.text);
      if (!text) {
        throw new Error(
          `La opcion ${optionIndex + 1} de la pregunta ${questionIndex + 1} no puede estar vacia`,
        );
      }

      return {
        id: normalizeOptionId(option.id, optionIndex),
        text,
      };
    });

    const optionIds = new Set(options.map((option) => option.id));
    if (optionIds.size !== options.length) {
      throw new Error(`La pregunta ${questionIndex + 1} tiene IDs de opcion duplicados`);
    }

    const correctOptionId = asTrimmedString(question.correctOptionId);
    if (!correctOptionId || !optionIds.has(correctOptionId)) {
      throw new Error(`La pregunta ${questionIndex + 1} debe marcar una respuesta correcta valida`);
    }

    return {
      id: normalizeQuestionId(question.id, questionIndex),
      prompt,
      options,
      correctOptionId,
    };
  });
}

export function calculateGlobalExamResult(
  questions: GlobalExamQuestion[],
  rawAnswers: unknown,
  passScore: number = GLOBAL_EXAM_PASS_SCORE,
): {
  answers: Record<string, string>;
  correctAnswers: number;
  totalQuestions: number;
  score: number;
  passed: boolean;
} {
  const answerEntries =
    rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)
      ? Object.entries(rawAnswers as Record<string, unknown>)
      : [];

  const answers = answerEntries.reduce<Record<string, string>>((acc, [questionId, answer]) => {
    const normalizedQuestionId = asTrimmedString(questionId);
    const normalizedAnswer = asTrimmedString(answer);
    if (!normalizedQuestionId || !normalizedAnswer) return acc;
    acc[normalizedQuestionId] = normalizedAnswer;
    return acc;
  }, {});

  const correctAnswers = questions.reduce((count, question) => {
    return answers[question.id] === question.correctOptionId ? count + 1 : count;
  }, 0);

  const totalQuestions = questions.length;
  const score = totalQuestions > 0 ? roundGlobalExamScore((correctAnswers / totalQuestions) * 100) : 0;

  return {
    answers,
    correctAnswers,
    totalQuestions,
    score,
    passed: score >= passScore,
  };
}
