import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firestore";

export type SurveyStatus = "draft" | "published" | "archived";
export type SurveySegment = "all" | "new_60d" | "old_60d";
export type SurveyQuestionType = "rating_1_5" | "single_choice" | "text";

export type SurveyQuestionOption = {
  id: string;
  label: string;
};

export type SurveyQuestion = {
  id: string;
  type: SurveyQuestionType;
  label: string;
  required: boolean;
  options?: SurveyQuestionOption[];
};

export type SatisfactionSurvey = {
  id: string;
  title: string;
  description: string;
  status: SurveyStatus;
  segment: SurveySegment;
  applyToFutureStudents: boolean;
  questions: SurveyQuestion[];
  publishedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  createdBy: string;
  updatedBy: string;
};

export type SurveyAnswer = {
  questionId: string;
  value: string | number;
};

export type SurveyResponse = {
  id: string;
  surveyId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  answers: SurveyAnswer[];
  submittedAt: Date | null;
  studentCreatedAtSnapshot: Date | null;
};

export type UpsertSurveyInput = {
  title: string;
  description?: string;
  status?: SurveyStatus;
  segment: SurveySegment;
  applyToFutureStudents: boolean;
  questions: SurveyQuestion[];
  updatedBy: string;
};

export type CreateSurveyInput = UpsertSurveyInput & {
  createdBy: string;
};

export type CreateSurveyResponseInput = {
  surveyId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  answers: SurveyAnswer[];
  studentCreatedAtSnapshot: Date | null;
};

const DAYS_60_MS = 60 * 24 * 60 * 60 * 1000;
const getSortTime = (value: Date | null): number => (value ? value.getTime() : 0);

const normalizeText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.trim() : fallback;

const normalizeBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const normalizeSurveyStatus = (value: unknown): SurveyStatus => {
  if (value === "draft" || value === "published" || value === "archived") {
    return value;
  }
  return "draft";
};

const normalizeSurveySegment = (value: unknown): SurveySegment => {
  if (value === "all" || value === "new_60d" || value === "old_60d") {
    return value;
  }
  return "all";
};

const normalizeQuestionType = (value: unknown): SurveyQuestionType => {
  if (value === "rating_1_5" || value === "single_choice" || value === "text") {
    return value;
  }
  return "text";
};

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value instanceof Timestamp) {
    const parsed = value.toDate();
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "object" && value !== null && "toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
    try {
      const parsed = (value as { toDate: () => Date }).toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    } catch {
      return null;
    }
  }
  return null;
};

const normalizeQuestions = (value: unknown): SurveyQuestion[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): SurveyQuestion | null => {
      if (!item || typeof item !== "object") return null;
      const question = item as Record<string, unknown>;
      const id = normalizeText(question.id);
      const label = normalizeText(question.label);
      if (!id || !label) return null;
      const type = normalizeQuestionType(question.type);
      const required = normalizeBoolean(question.required, false);
      const options =
        type === "single_choice" && Array.isArray(question.options)
          ? question.options
              .map((option): SurveyQuestionOption | null => {
                if (!option || typeof option !== "object") return null;
                const optionRecord = option as Record<string, unknown>;
                const optionId = normalizeText(optionRecord.id);
                const optionLabel = normalizeText(optionRecord.label);
                if (!optionId || !optionLabel) return null;
                return { id: optionId, label: optionLabel };
              })
              .filter((option): option is SurveyQuestionOption => option !== null)
          : [];
      return {
        id,
        type,
        label,
        required,
        ...(type === "single_choice" ? { options } : {}),
      };
    })
    .filter((question): question is SurveyQuestion => question !== null);
};

const mapSurvey = (id: string, data: Record<string, unknown>): SatisfactionSurvey => ({
  id,
  title: normalizeText(data.title, "Encuesta sin título"),
  description: normalizeText(data.description),
  status: normalizeSurveyStatus(data.status),
  segment: normalizeSurveySegment(data.segment),
  applyToFutureStudents: normalizeBoolean(data.applyToFutureStudents, true),
  questions: normalizeQuestions(data.questions),
  publishedAt: toDate(data.publishedAt),
  createdAt: toDate(data.createdAt),
  updatedAt: toDate(data.updatedAt),
  createdBy: normalizeText(data.createdBy),
  updatedBy: normalizeText(data.updatedBy),
});

const mapSurveyResponse = (id: string, data: Record<string, unknown>): SurveyResponse => ({
  id,
  surveyId: normalizeText(data.surveyId),
  studentId: normalizeText(data.studentId),
  studentName: normalizeText(data.studentName, "Estudiante"),
  studentEmail: normalizeText(data.studentEmail),
  answers: Array.isArray(data.answers)
    ? data.answers
        .map((item): SurveyAnswer | null => {
          if (!item || typeof item !== "object") return null;
          const record = item as Record<string, unknown>;
          const questionId = normalizeText(record.questionId);
          const value = record.value;
          if (!questionId) return null;
          if (typeof value !== "string" && typeof value !== "number") return null;
          return { questionId, value };
        })
        .filter((answer): answer is SurveyAnswer => answer !== null)
    : [],
  submittedAt: toDate(data.submittedAt),
  studentCreatedAtSnapshot: toDate(data.studentCreatedAtSnapshot),
});

const sanitizeQuestionsForSave = (questions: SurveyQuestion[]): SurveyQuestion[] =>
  questions
    .map((question) => ({
      id: normalizeText(question.id),
      type: normalizeQuestionType(question.type),
      label: normalizeText(question.label),
      required: Boolean(question.required),
      options:
        question.type === "single_choice"
          ? (question.options ?? [])
              .map((option) => ({
                id: normalizeText(option.id),
                label: normalizeText(option.label),
              }))
              .filter((option) => option.id && option.label)
          : undefined,
    }))
    .filter((question) => question.id && question.label);

export function buildSurveyResponseId(surveyId: string, studentId: string): string {
  return `${surveyId.trim()}_${studentId.trim()}`;
}

export function isStudentEligibleForSurvey(params: {
  survey: SatisfactionSurvey;
  studentCreatedAt: Date | null;
}): boolean {
  const { survey, studentCreatedAt } = params;
  if (!studentCreatedAt) return survey.segment === "all";

  const now = Date.now();
  const ageMs = now - studentCreatedAt.getTime();
  const isNew = ageMs <= DAYS_60_MS;
  const isOld = ageMs > DAYS_60_MS;
  const segmentEligible =
    survey.segment === "all" ||
    (survey.segment === "new_60d" && isNew) ||
    (survey.segment === "old_60d" && isOld);

  if (!segmentEligible) return false;

  if (!survey.applyToFutureStudents && survey.publishedAt) {
    return studentCreatedAt.getTime() <= survey.publishedAt.getTime();
  }

  return true;
}

export async function getSatisfactionSurveys(maxResults = 200): Promise<SatisfactionSurvey[]> {
  const snap = await getDocs(
    query(
      collection(db, "satisfactionSurveys"),
      orderBy("updatedAt", "desc"),
      limit(maxResults),
    ),
  );
  return snap.docs.map((docSnap) => mapSurvey(docSnap.id, docSnap.data()));
}

export async function getPublishedSatisfactionSurveys(maxResults = 100): Promise<SatisfactionSurvey[]> {
  const snap = await getDocs(
    query(
      collection(db, "satisfactionSurveys"),
      where("status", "==", "published"),
      limit(maxResults),
    ),
  );
  return snap.docs
    .map((docSnap) => mapSurvey(docSnap.id, docSnap.data()))
    .sort((a, b) => getSortTime(b.publishedAt) - getSortTime(a.publishedAt));
}

export async function createSatisfactionSurvey(input: CreateSurveyInput): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new Error("title es requerido");
  const createdBy = input.createdBy.trim();
  const updatedBy = input.updatedBy.trim();
  if (!createdBy || !updatedBy) {
    throw new Error("createdBy y updatedBy son requeridos");
  }
  const status = normalizeSurveyStatus(input.status ?? "draft");
  const questions = sanitizeQuestionsForSave(input.questions);
  if (!questions.length) {
    throw new Error("Agrega al menos una pregunta válida");
  }
  const now = new Date();
  const ref = await addDoc(collection(db, "satisfactionSurveys"), {
    title,
    description: (input.description ?? "").trim(),
    status,
    segment: normalizeSurveySegment(input.segment),
    applyToFutureStudents: Boolean(input.applyToFutureStudents),
    questions,
    publishedAt: status === "published" ? now : null,
    createdAt: now,
    updatedAt: now,
    createdBy,
    updatedBy,
  });
  return ref.id;
}

export async function updateSatisfactionSurvey(
  surveyId: string,
  input: UpsertSurveyInput,
): Promise<void> {
  const normalizedSurveyId = surveyId.trim();
  if (!normalizedSurveyId) throw new Error("surveyId es requerido");

  const title = input.title.trim();
  if (!title) throw new Error("title es requerido");
  const updatedBy = input.updatedBy.trim();
  if (!updatedBy) throw new Error("updatedBy es requerido");
  const status = normalizeSurveyStatus(input.status ?? "draft");
  const questions = sanitizeQuestionsForSave(input.questions);
  if (!questions.length) {
    throw new Error("Agrega al menos una pregunta válida");
  }

  const ref = doc(db, "satisfactionSurveys", normalizedSurveyId);
  const snap = await getDoc(ref);
  const previous = snap.exists() ? mapSurvey(snap.id, snap.data()) : null;
  const nextPublishedAt =
    status === "published"
      ? previous?.publishedAt ?? new Date()
      : null;

  await updateDoc(ref, {
    title,
    description: (input.description ?? "").trim(),
    status,
    segment: normalizeSurveySegment(input.segment),
    applyToFutureStudents: Boolean(input.applyToFutureStudents),
    questions,
    updatedAt: new Date(),
    updatedBy,
    publishedAt: nextPublishedAt,
  });
}

export async function setSatisfactionSurveyStatus(params: {
  surveyId: string;
  status: SurveyStatus;
  updatedBy: string;
}): Promise<void> {
  const surveyId = params.surveyId.trim();
  const updatedBy = params.updatedBy.trim();
  if (!surveyId || !updatedBy) {
    throw new Error("surveyId y updatedBy son requeridos");
  }
  const ref = doc(db, "satisfactionSurveys", surveyId);
  await updateDoc(ref, {
    status: normalizeSurveyStatus(params.status),
    updatedAt: new Date(),
    updatedBy,
    ...(params.status === "published" ? { publishedAt: new Date() } : {}),
  });
}

export async function getSurveyResponse(
  surveyId: string,
  studentId: string,
): Promise<SurveyResponse | null> {
  const id = buildSurveyResponseId(surveyId, studentId);
  const snap = await getDoc(doc(db, "surveyResponses", id));
  if (!snap.exists()) return null;
  return mapSurveyResponse(snap.id, snap.data());
}

export async function saveSurveyResponse(input: CreateSurveyResponseInput): Promise<string> {
  const surveyId = input.surveyId.trim();
  const studentId = input.studentId.trim();
  if (!surveyId || !studentId) {
    throw new Error("surveyId y studentId son requeridos");
  }
  if (!input.answers.length) {
    throw new Error("Debes responder al menos una pregunta");
  }
  const responseId = buildSurveyResponseId(surveyId, studentId);
  const ref = doc(db, "surveyResponses", responseId);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    return responseId;
  }
  await setDoc(ref, {
    surveyId,
    studentId,
    studentName: input.studentName.trim() || "Estudiante",
    studentEmail: input.studentEmail.trim().toLowerCase(),
    answers: input.answers,
    studentCreatedAtSnapshot: input.studentCreatedAtSnapshot ?? null,
    submittedAt: new Date(),
  });
  return responseId;
}

export async function getSurveyResponsesBySurveyId(
  surveyId: string,
  maxResults = 5000,
): Promise<SurveyResponse[]> {
  const normalizedSurveyId = surveyId.trim();
  if (!normalizedSurveyId) return [];
  const snap = await getDocs(
    query(
      collection(db, "surveyResponses"),
      where("surveyId", "==", normalizedSurveyId),
      limit(maxResults),
    ),
  );
  return snap.docs
    .map((docSnap) => mapSurveyResponse(docSnap.id, docSnap.data()))
    .sort((a, b) => getSortTime(b.submittedAt) - getSortTime(a.submittedAt));
}
