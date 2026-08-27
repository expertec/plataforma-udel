"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import toast from "react-hot-toast";
import { Download, ExternalLink, Eye, X } from "lucide-react";
import { jsPDF } from "jspdf";
import { db } from "@/lib/firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { getGroupStudents } from "@/lib/firebase/groups-service";
import {
  GLOBAL_EXAM_DURATION_MINUTES,
  type GlobalExamQuestion,
  type GlobalExamTemplateRecord,
} from "@/lib/global-exams/types";
import { createGlobalExamAssignment, createGlobalExamTemplate } from "@/lib/global-exams/client";
import {
  parseWordCourseTemplate,
  type WordImportedQuizQuestion,
} from "@/lib/course-word-template-parser";
import {
  Submission,
  getAllSubmissions,
  hasNumericSubmissionGrade,
  shouldPreferIncomingSubmission,
} from "@/lib/firebase/submissions-service";
import { getForumPosts } from "@/lib/firebase/forum-service";
import { UserRole, isAdminTeacherRole } from "@/lib/firebase/roles";
import { isExamOptionalProgram } from "@/lib/program-level";

type CalificacionesTabProps = {
  groupId: string;
  courses: Array<{ courseId: string; courseName: string; program?: string }>;
  groupProgram?: string;
  groupTeacherId: string;
  currentUserId: string | null;
  userRole: UserRole | null;
  enableCampusTasksGrade?: boolean;
  enableCampusFinalExamGrade?: boolean;
  enableGlobalExamGrade?: boolean;
  enableExtraordinaryExamGrade?: boolean;
  canManageClosuresOverride?: boolean;
  onCourseCompletedAndUnlinked?: (courseId: string) => Promise<void> | void;
};

type Student = { id: string; name: string };

type Task = {
  id: string;
  lessonId: string;
  title: string;
  classType: "quiz" | "assignment" | "forum" | "activity";
};

type QuizQuestionConfig = {
  pointValue: number;
  correctOptionIds: string[];
};

type QuizClassConfig = {
  totalPoints: number;
  questionsById: Record<string, QuizQuestionConfig>;
};

type AutoBreakdownEntry = {
  classId: string;
  classTitle: string;
  classType: Task["classType"];
  grade: number | null;
  hasSubmission: boolean;
  isMarkedGraded: boolean;
  submissionId?: string;
  submittedAt?: Date | null;
  gradedAt?: Date | null;
  gradedById?: string;
  gradedByName?: string;
};

type ExtraConceptGrade = {
  id: string;
  concept: string;
  points: number;
};

type ExtraConceptDefinition = {
  id: string;
  concept: string;
  defaultPoints?: number | null;
};

type ExtraConceptDraft = {
  id: string;
  concept: string;
  defaultPoints: string;
};

type ExamTemplateKind = "global" | "extraordinary";

type ExamQuestionType = "opcion_multiple" | "seleccion_multiple" | "verdadero_falso" | "respuesta_corta";

type CourseExamTemplate = {
  kind: ExamTemplateKind;
  fileName: string;
  fileSize: number | null;
  contentType: string;
  storagePath: string;
  downloadUrl: string;
  uploadedAt: Date | null;
  uploadedById: string | null;
  uploadedByName: string | null;
  structuredTemplateId?: string | null;
};

type CourseExamTemplates = Partial<Record<ExamTemplateKind, CourseExamTemplate>>;

type ExtraConceptResolution = {
  concepts: ExtraConceptGrade[];
  totalPoints: number;
  errorMessage: string | null;
};

type CourseConceptsResolution = {
  concepts: ExtraConceptDefinition[];
  errorMessage: string | null;
};

type CourseClosureState = {
  status?: "open" | "closed";
  courseName?: string;
  finalGrade?: number;
  autoGrade?: number | null;
  campusTasksGrade?: number | null;
  campusFinalExamGrade?: number | null;
  globalExamGrade?: number | null;
  extraordinaryExamGrade?: number | null;
  extraConcepts?: ExtraConceptGrade[];
  extraPointsTotal?: number | null;
  manualOverride?: boolean;
  pendingUngradedCount?: number;
  closedByType?: "teacher" | "system";
  closureTrigger?: "manual" | "automatic";
  lastFinalGradeNotifiedAt?: Date | null;
  lastFinalGradeNotifiedBy?: string;
  lastFinalGradeNotifiedValue?: number;
  closedAt?: Date | null;
  closedById?: string;
  closedByName?: string;
  reopenedAt?: Date | null;
  reopenedById?: string;
  reopenedByName?: string;
  updatedAt?: Date | null;
};

type StudentEnrollmentsApiResponse = {
  success?: boolean;
  error?: string;
  data?: {
    enrollments?: Array<Record<string, unknown> & { __id: string }>;
  };
};

type GlobalExamTemplateApiResponse = {
  success?: boolean;
  error?: string;
  data?: GlobalExamTemplateRecord | null;
};

type EnrollmentRecord = {
  id: string;
  courseClosures: Record<string, CourseClosureState>;
  studentName?: string;
};

type StudentCourseRow = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  autoGrade: number | null;
  autoBreakdown: AutoBreakdownEntry[];
  pendingUngradedCount: number;
  gradedCount: number;
  totalEvaluable: number;
  closure: CourseClosureState | null;
};

type AutoExtraordinaryExamAssignmentCandidate = {
  row: StudentCourseRow;
  finalGrade: number;
};

type AutoExtraordinaryExamAssignmentSummary = {
  candidateCount: number;
  assignedCount: number;
  alreadyAssignedCount: number;
  failedStudentNames: string[];
  skippedReason: "none" | "no-template" | "unpublished-template";
};

type ClosureDocumentRow = {
  studentId: string;
  studentName: string;
  autoGrade: number | null;
  finalGrade: number;
  pendingUngradedCount: number;
  totalEvaluable: number;
};

type SignatureModalContext = {
  scope: "single" | "all";
  courseId: string;
  courseName: string;
  rows: ClosureDocumentRow[];
  requestedAt: Date;
};

type SignatureResult = {
  signerName: string;
  signedAt: Date;
  signatureDataUrl: string;
  context: SignatureModalContext;
};

type ConfirmationModalContext = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "warning" | "danger";
};

type MammothResult = {
  value: string;
  messages: Array<{ type: string; message: string }>;
};

type MammothModule = {
  extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<MammothResult>;
};

type ExamTemplatePreviewQuestion = {
  id: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
};

type ExamTemplatePreviewState = {
  template: CourseExamTemplate;
  questions: ExamTemplatePreviewQuestion[];
  loading: boolean;
  error: string | null;
};

const toConceptComparable = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const toConceptSuggestionDocId = (value: string) => {
  const normalized = toConceptComparable(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return "";
  return normalized.slice(0, 90);
};

const createExtraConceptId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const getCourseExtrasDocId = (courseId: string) => `__courseExtras__${courseId}`;
const EXTRAORDINARY_EXAM_AUTO_ASSIGN_MIN_EXCLUSIVE = 50;
const EXTRAORDINARY_EXAM_AUTO_ASSIGN_MAX_EXCLUSIVE = 70;
const EXTRAORDINARY_EXAM_AUTO_ASSIGN_BATCH_SIZE = 10;

const normalizeExtraConcepts = (value: unknown, idPrefix: string): ExtraConceptGrade[] =>
  Array.isArray(value)
    ? value
        .map((entry, index): ExtraConceptGrade | null => {
          if (!entry || typeof entry !== "object") return null;
          const extraEntry = entry as Record<string, unknown>;
          const concept = typeof extraEntry.concept === "string" ? extraEntry.concept.trim() : "";
          const points =
            typeof extraEntry.points === "number" && Number.isFinite(extraEntry.points)
              ? Math.round(extraEntry.points * 10) / 10
              : null;
          if (!concept || points === null || points < 0) return null;
          const id =
            typeof extraEntry.id === "string" && extraEntry.id.trim().length > 0
              ? extraEntry.id.trim()
              : `${idPrefix}-extra-${index + 1}`;
          return { id, concept, points };
        })
        .filter((entry): entry is ExtraConceptGrade => entry !== null)
    : [];

const normalizeExtraConceptDefinitions = (
  value: unknown,
  idPrefix: string,
): ExtraConceptDefinition[] =>
  Array.isArray(value)
    ? value
        .map((entry, index): ExtraConceptDefinition | null => {
          if (!entry || typeof entry !== "object") return null;
          const conceptEntry = entry as Record<string, unknown>;
          const concept = typeof conceptEntry.concept === "string" ? conceptEntry.concept.trim() : "";
          if (!concept) return null;
          const defaultPoints =
            typeof conceptEntry.defaultPoints === "number" && Number.isFinite(conceptEntry.defaultPoints)
              ? Math.round(Math.max(0, conceptEntry.defaultPoints) * 10) / 10
              : null;
          const id =
            typeof conceptEntry.id === "string" && conceptEntry.id.trim().length > 0
              ? conceptEntry.id.trim()
              : `${idPrefix}-extra-${index + 1}`;
          return { id, concept, defaultPoints };
        })
        .filter((entry): entry is ExtraConceptDefinition => entry !== null)
    : [];

const formatDefaultPointsDraftInput = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? (Math.round(value * 10) / 10).toFixed(1) : "";

const EXAM_TEMPLATE_KIND_LABELS: Record<ExamTemplateKind, string> = {
  global: "Examen global",
  extraordinary: "Examen extraordinario",
};

const EXAM_QUESTION_TYPE_LABELS: Record<ExamQuestionType, string> = {
  opcion_multiple: "Opción múltiple",
  seleccion_multiple: "Selección múltiple",
  verdadero_falso: "Verdadero/Falso",
  respuesta_corta: "Respuesta corta",
};

const EXAM_TEMPLATE_ACCEPT =
  ".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_EXAM_TEMPLATE_FILE_SIZE = 25 * 1024 * 1024;
const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];

const normalizeTextValue = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const isWordExamTemplateName = (fileName: string) => {
  const lowerName = fileName.toLowerCase();
  return lowerName.endsWith(".doc") || lowerName.endsWith(".docx");
};

const isWordExamTemplateFile = (file: File) =>
  isWordExamTemplateName(file.name) ||
  file.type === "application/msword" ||
  file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const formatFileSize = (bytes?: number | null) => {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "Tamaño no disponible";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const normalizeExamPreviewLine = (value: string): string =>
  value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const htmlDocumentToPlainText = (html: string): string => {
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<td[^>]*>/gi, "\t")
    .replace(/<[^>]+>/g, " ");
  if (typeof window === "undefined") return withBreaks;
  const textarea = window.document.createElement("textarea");
  textarea.innerHTML = withBreaks;
  return textarea.value;
};

async function extractRawTextFromExamTemplateFile(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith(".docx")) {
    const mammothImport = (await import("mammoth")) as unknown as {
      default?: MammothModule;
    } & MammothModule;
    const mammoth = mammothImport.default ?? mammothImport;
    const result = await mammoth.extractRawText({
      arrayBuffer: await file.arrayBuffer(),
    });
    return result.value;
  }

  const rawText = await file.text();
  return /<html|<body|<p|<table|<br/i.test(rawText)
    ? htmlDocumentToPlainText(rawText)
    : rawText;
}

const isExamQuestionStartLine = (line: string): { prompt: string; consumesNextPrompt: boolean } | null => {
  const inline = line.match(/^(\d{1,3})[\).]\s+(.+)$/);
  if (inline) return { prompt: inline[2].trim(), consumesNextPrompt: false };
  if (/^\d{1,3}$/.test(line)) return { prompt: "", consumesNextPrompt: true };
  return null;
};

const parseExamOptionLine = (line: string): { letter: string; text: string } | null => {
  const match = line.match(/^([A-Fa-f])[\).]\s*(.*)$/);
  if (!match) return null;
  return {
    letter: match[1].toUpperCase(),
    text: match[2].trim(),
  };
};

const isAnswerOrScoreLine = (line: string): boolean =>
  /^respuesta\s+correcta\s*:/i.test(line) ||
  /^puntaje\s*:/i.test(line) ||
  /^tipo\s+admitido\s*:/i.test(line) ||
  /^correcta$/i.test(line) ||
  /^\d+(?:[.,]\d+)?\s*(puntos?)?$/i.test(line);

const normalizePreviewOptionId = (index: number): string => OPTION_LETTERS[index]?.toLowerCase() ?? `opcion_${index + 1}`;

function parseExamQuestionsFromLines(lines: string[]): ExamTemplatePreviewQuestion[] {
  const questions: ExamTemplatePreviewQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = isExamQuestionStartLine(lines[i] ?? "");
    if (!start) {
      i += 1;
      continue;
    }

    i += 1;
    const promptLines: string[] = [];
    if (start.prompt) {
      promptLines.push(start.prompt);
    } else if (start.consumesNextPrompt) {
      while (i < lines.length) {
        const nextLine = lines[i] ?? "";
        if (!nextLine || parseExamOptionLine(nextLine) || isAnswerOrScoreLine(nextLine)) break;
        if (isExamQuestionStartLine(nextLine)) break;
        promptLines.push(nextLine);
        i += 1;
        if (nextLine.includes("?") || nextLine.endsWith(":")) break;
      }
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
      promptLines.push(line);
      i += 1;
    }

    const options: Array<{ id: string; text: string }> = [];
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (isExamQuestionStartLine(line)) break;
      if (isAnswerOrScoreLine(line)) {
        i += 1;
        continue;
      }

      const optionStart = parseExamOptionLine(line);
      if (!optionStart) {
        i += 1;
        continue;
      }

      i += 1;
      const optionTextLines = optionStart.text ? [optionStart.text] : [];
      while (i < lines.length) {
        const optionLine = lines[i] ?? "";
        if (
          parseExamOptionLine(optionLine) ||
          isAnswerOrScoreLine(optionLine) ||
          isExamQuestionStartLine(optionLine)
        ) {
          break;
        }
        optionTextLines.push(optionLine);
        i += 1;
      }

      const optionText = optionTextLines.join(" ").trim();
      if (optionText) {
        options.push({
          id: normalizePreviewOptionId(options.length),
          text: optionText,
        });
      }
    }

    const prompt = promptLines.join(" ").trim();
    if (prompt && options.length > 0) {
      questions.push({
        id: `preview_question_${questions.length + 1}`,
        prompt,
        options,
      });
    }
  }

  return questions;
}

function quizQuestionsToPreviewQuestions(quizQuestions: WordImportedQuizQuestion[]): ExamTemplatePreviewQuestion[] {
  return quizQuestions
    .filter((question) => question.prompt.trim() && question.options.length > 0)
    .map((question, questionIndex) => ({
      id: `preview_question_${questionIndex + 1}`,
      prompt: question.prompt.trim(),
      options: question.options
        .filter((option) => option.text.trim())
        .map((option, optionIndex) => ({
          id: normalizePreviewOptionId(optionIndex),
          text: option.text.trim(),
        })),
    }));
}

async function parseExamTemplatePreviewQuestions(file: File): Promise<ExamTemplatePreviewQuestion[]> {
  const rawText = await extractRawTextFromExamTemplateFile(file);
  const normalizedLines = rawText
    .split(/\r?\n/)
    .map(normalizeExamPreviewLine)
    .filter(Boolean);

  const parsedByExamFormat = parseExamQuestionsFromLines(normalizedLines);
  if (parsedByExamFormat.length > 0) return parsedByExamFormat;

  const lessons = parseWordCourseTemplate(rawText, "Plantilla de examen");
  const quizQuestions = lessons.flatMap((lesson) =>
    lesson.classes.flatMap((classItem) => classItem.quizQuestions ?? []),
  );
  return quizQuestionsToPreviewQuestions(quizQuestions);
}

function parseStructuredExamQuestionsFromLines(lines: string[]): GlobalExamQuestion[] {
  const questions: GlobalExamQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    const start = isExamQuestionStartLine(lines[i] ?? "");
    if (!start) {
      i += 1;
      continue;
    }

    i += 1;
    const promptLines: string[] = [];
    if (start.prompt) {
      promptLines.push(start.prompt);
    } else {
      while (i < lines.length) {
        const line = lines[i] ?? "";
        if (!line || parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
        promptLines.push(line);
        i += 1;
        if (line.includes("?") || line.endsWith(":")) break;
      }
    }

    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (parseExamOptionLine(line) || isAnswerOrScoreLine(line) || isExamQuestionStartLine(line)) break;
      promptLines.push(line);
      i += 1;
    }

    const options: Array<{ id: string; text: string; sourceLetter: string }> = [];
    let correctLetter = "";
    while (i < lines.length) {
      const line = lines[i] ?? "";
      const nextQuestion = isExamQuestionStartLine(line);
      if (nextQuestion) break;

      const answerMatch = line.match(/^respuesta\s+correcta\s*:\s*([A-Fa-f])/i);
      if (answerMatch) {
        correctLetter = answerMatch[1].toUpperCase();
        i += 1;
        continue;
      }

      const optionStart = parseExamOptionLine(line);
      if (!optionStart) {
        i += 1;
        continue;
      }

      i += 1;
      const optionTextLines = optionStart.text ? [optionStart.text] : [];
      while (i < lines.length) {
        const optionLine = lines[i] ?? "";
        if (
          parseExamOptionLine(optionLine) ||
          /^respuesta\s+correcta\s*:/i.test(optionLine) ||
          isAnswerOrScoreLine(optionLine) ||
          isExamQuestionStartLine(optionLine)
        ) {
          break;
        }
        optionTextLines.push(optionLine);
        i += 1;
      }

      const optionText = optionTextLines.join(" ").trim();
      if (optionText) {
        options.push({
          id: normalizePreviewOptionId(options.length),
          text: optionText,
          sourceLetter: optionStart.letter,
        });
      }
    }

    const prompt = promptLines.join(" ").trim();
    const correctOption =
      options.find((option) => option.sourceLetter === correctLetter) ?? options[0] ?? null;
    if (prompt && options.length > 0 && correctOption) {
      questions.push({
        id: `question_${questions.length + 1}`,
        prompt,
        options: options.map(({ id, text }) => ({ id, text })),
        correctOptionId: correctOption.id,
      });
    }
  }

  return questions;
}

function quizQuestionsToGlobalExamQuestions(quizQuestions: WordImportedQuizQuestion[]): GlobalExamQuestion[] {
  return quizQuestions
    .map((question, questionIndex): GlobalExamQuestion | null => {
      const options = question.options
        .filter((option) => option.text.trim())
        .map((option, optionIndex) => ({
          id: normalizePreviewOptionId(optionIndex),
          text: option.text.trim(),
          isCorrect: option.isCorrect,
        }));
      const correctOption = options.find((option) => option.isCorrect) ?? options[0] ?? null;
      if (!question.prompt.trim() || options.length === 0 || !correctOption) return null;
      return {
        id: `question_${questionIndex + 1}`,
        prompt: question.prompt.trim(),
        options: options.map(({ id, text }) => ({ id, text })),
        correctOptionId: correctOption.id,
      };
    })
    .filter((question): question is GlobalExamQuestion => question !== null);
}

async function parseGlobalExamQuestionsFromTemplateFile(file: File): Promise<GlobalExamQuestion[]> {
  const rawText = await extractRawTextFromExamTemplateFile(file);
  const normalizedLines = rawText
    .split(/\r?\n/)
    .map(normalizeExamPreviewLine)
    .filter(Boolean);

  const parsedByExamFormat = parseStructuredExamQuestionsFromLines(normalizedLines);
  if (parsedByExamFormat.length > 0) return parsedByExamFormat;

  const lessons = parseWordCourseTemplate(rawText, "Plantilla de examen");
  const quizQuestions = lessons.flatMap((lesson) =>
    lesson.classes.flatMap((classItem) => classItem.quizQuestions ?? []),
  );
  return quizQuestionsToGlobalExamQuestions(quizQuestions);
}

const normalizeCourseExamTemplate = (
  value: unknown,
  kind: ExamTemplateKind,
): CourseExamTemplate | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const templateData = value as Record<string, unknown>;
  const fileName =
    normalizeTextValue(templateData.fileName) || normalizeTextValue(templateData.sourceFileName);
  const downloadUrl = normalizeTextValue(templateData.downloadUrl);
  const storagePath = normalizeTextValue(templateData.storagePath);
  if (!fileName || !downloadUrl || !storagePath || !isWordExamTemplateName(fileName)) return null;
  const fileSize = typeof templateData.fileSize === "number" && Number.isFinite(templateData.fileSize)
    ? templateData.fileSize
    : null;

  return {
    kind,
    fileName,
    fileSize,
    contentType: normalizeTextValue(templateData.contentType),
    storagePath,
    downloadUrl,
    uploadedAt: toDateOrNull(templateData.uploadedAt),
    uploadedById: normalizeTextValue(templateData.uploadedById) || null,
    uploadedByName: normalizeTextValue(templateData.uploadedByName) || null,
    structuredTemplateId: normalizeTextValue(templateData.structuredTemplateId) || null,
  };
};

const normalizeCourseExamTemplates = (value: unknown): CourseExamTemplates => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const templates = value as Record<string, unknown>;
  return {
    global: normalizeCourseExamTemplate(templates.global, "global") ?? undefined,
    extraordinary:
      normalizeCourseExamTemplate(templates.extraordinary, "extraordinary") ?? undefined,
  };
};

const toExtraConceptDrafts = (
  concepts?: Array<Pick<ExtraConceptDefinition, "id" | "concept" | "defaultPoints">> | null,
): ExtraConceptDraft[] =>
  (concepts ?? []).map((entry) => ({
    id: entry.id,
    concept: entry.concept,
    defaultPoints: formatDefaultPointsDraftInput(entry.defaultPoints),
  }));

const toDateOrNull = (value: unknown): Date | null => {
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

const formatDate = (value?: Date | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
};

const formatDateTime = (value?: Date | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
};

const formatGradeValue = (value?: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";

const closureOriginLabel = (closure?: CourseClosureState | null) => {
  if (closure?.closureTrigger === "automatic" || closure?.closedByType === "system") {
    return "Cierre automático";
  }
  if (closure?.closureTrigger === "manual" || closure?.closedByType === "teacher") {
    return "Cierre por docente";
  }
  return null;
};

const taskTypeLabel = (classType: Task["classType"]) => {
  if (classType === "quiz") return "Quiz";
  if (classType === "forum") return "Foro";
  if (classType === "assignment") return "Tarea";
  return "Actividad";
};

const normalizeQuizPointValue = (value: unknown): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number(typeof value === "string" ? value.trim().replace(",", ".") : value);
  if (!Number.isFinite(parsed)) return 1;
  const bounded = Math.max(0, Math.min(parsed, 100));
  return Math.round(bounded * 100) / 100;
};

const isPermissionDeniedError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "permission-denied";

export function CalificacionesTab({
  groupId,
  courses,
  groupProgram = "",
  groupTeacherId,
  currentUserId,
  userRole,
  enableCampusTasksGrade = false,
  enableCampusFinalExamGrade = false,
  enableGlobalExamGrade = false,
  enableExtraordinaryExamGrade = false,
  canManageClosuresOverride,
  onCourseCompletedAndUnlinked,
}: CalificacionesTabProps) {
  const [students, setStudents] = useState<Student[]>([]);
  const [tasksByCourse, setTasksByCourse] = useState<Record<string, Task[]>>({});
  const [quizConfigByClass, setQuizConfigByClass] = useState<Record<string, QuizClassConfig>>({});
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [enrollmentByStudent, setEnrollmentByStudent] = useState<Record<string, EnrollmentRecord>>({});
  const [selectedCourseId, setSelectedCourseId] = useState<string>(courses[0]?.courseId ?? "");
  const [draftCampusTasksGrades, setDraftCampusTasksGrades] = useState<Record<string, string>>({});
  const [draftCampusFinalExamGrades, setDraftCampusFinalExamGrades] = useState<Record<string, string>>({});
  const [draftGlobalExamGrades, setDraftGlobalExamGrades] = useState<Record<string, string>>({});
  const [draftExtraordinaryExamGrades, setDraftExtraordinaryExamGrades] = useState<Record<string, string>>({});
  const [draftExtraConceptsByCourse, setDraftExtraConceptsByCourse] = useState<Record<string, ExtraConceptDraft[]>>({});
  const [draftExtraPointsByStudent, setDraftExtraPointsByStudent] = useState<Record<string, Record<string, string>>>({});
  const [draftFinalGrades, setDraftFinalGrades] = useState<Record<string, string>>({});
  const [courseExamTemplatesByCourse, setCourseExamTemplatesByCourse] = useState<Record<string, CourseExamTemplates>>({});
  const [courseProgramsByCourse, setCourseProgramsByCourse] = useState<Record<string, string>>({});
  const [existingGlobalExamTemplatesByCourse, setExistingGlobalExamTemplatesByCourse] = useState<
    Record<string, GlobalExamTemplateRecord | null>
  >({});
  const [existingExtraordinaryExamTemplatesByCourse, setExistingExtraordinaryExamTemplatesByCourse] = useState<
    Record<string, GlobalExamTemplateRecord | null>
  >({});
  const [extraConceptSuggestions, setExtraConceptSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingTemplateKind, setUploadingTemplateKind] = useState<ExamTemplateKind | null>(null);
  const [processingStudentId, setProcessingStudentId] = useState<string | null>(null);
  const [processingNotifyStudentId, setProcessingNotifyStudentId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);
  const [breakdownStudentId, setBreakdownStudentId] = useState<string | null>(null);
  const [extraConceptModalOpen, setExtraConceptModalOpen] = useState(false);
  const [extraConceptModalDrafts, setExtraConceptModalDrafts] = useState<ExtraConceptDraft[]>([]);
  const [extraConceptModalError, setExtraConceptModalError] = useState<string | null>(null);
  const [savingExtraConceptModal, setSavingExtraConceptModal] = useState(false);
  const [exportingGradesPdf, setExportingGradesPdf] = useState(false);
  const [activeExtraConceptDropdownId, setActiveExtraConceptDropdownId] = useState<string | null>(null);
  const [signatureModalContext, setSignatureModalContext] = useState<SignatureModalContext | null>(null);
  const [signerNameInput, setSignerNameInput] = useState("");
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const [hasSignatureStroke, setHasSignatureStroke] = useState(false);
  const [confirmationModalContext, setConfirmationModalContext] = useState<ConfirmationModalContext | null>(null);
  const [examTemplatesModalOpen, setExamTemplatesModalOpen] = useState(false);
  const [examTemplatePreview, setExamTemplatePreview] = useState<ExamTemplatePreviewState | null>(null);

  const signatureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingSignatureRef = useRef(false);
  const signatureLastPointRef = useRef<{ x: number; y: number } | null>(null);
  const signatureModalResolverRef = useRef<((value: SignatureResult | null) => void) | null>(null);
  const confirmationModalResolverRef = useRef<((value: boolean) => void) | null>(null);
  const examTemplatesModalResolverRef = useRef<((value: boolean) => void) | null>(null);
  const pdfBackgroundDataUrlRef = useRef<string | null>(null);
  const pdfLogoDataUrlRef = useRef<string | null>(null);

  const canManageClosures = useMemo(() => {
    if (typeof canManageClosuresOverride === "boolean") return canManageClosuresOverride;
    if (!currentUserId) return false;
    return currentUserId === groupTeacherId || isAdminTeacherRole(userRole);
  }, [canManageClosuresOverride, currentUserId, groupTeacherId, userRole]);

  useEffect(() => {
    if (!selectedCourseId && courses.length > 0) {
      setSelectedCourseId(courses[0].courseId);
      return;
    }
    if (selectedCourseId && courses.length > 0 && !courses.some((course) => course.courseId === selectedCourseId)) {
      setSelectedCourseId(courses[0].courseId);
    }
  }, [courses, selectedCourseId]);

  const selectedCourse = useMemo(
    () => courses.find((course) => course.courseId === selectedCourseId) ?? null,
    [courses, selectedCourseId],
  );
  const selectedCourseProgram =
    selectedCourse?.program?.trim() ||
    (selectedCourseId ? courseProgramsByCourse[selectedCourseId]?.trim() : "") ||
    groupProgram.trim();
  const selectedCourseSkipsExamTemplates = isExamOptionalProgram(selectedCourseProgram);

  const resolveSelectedCourseProgram = useCallback(async (): Promise<string> => {
    const courseId = selectedCourseId.trim();
    const directProgram = selectedCourse?.program?.trim();
    if (directProgram) return directProgram;
    if (!courseId) return groupProgram.trim();
    if (Object.prototype.hasOwnProperty.call(courseProgramsByCourse, courseId)) {
      return courseProgramsByCourse[courseId]?.trim() || groupProgram.trim();
    }

    try {
      const courseSnap = await getDoc(doc(db, "courses", courseId));
      const data = courseSnap.data() as { program?: unknown; category?: unknown } | undefined;
      const program =
        typeof data?.program === "string"
          ? data.program.trim()
          : typeof data?.category === "string"
            ? data.category.trim()
            : "";
      setCourseProgramsByCourse((prev) => ({
        ...prev,
        [courseId]: program,
      }));
      return program || groupProgram.trim();
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        console.warn("No se pudo cargar el programa de la materia:", error);
      }
      setCourseProgramsByCourse((prev) => ({
        ...prev,
        [courseId]: "",
      }));
      return groupProgram.trim();
    }
  }, [courseProgramsByCourse, groupProgram, selectedCourse?.program, selectedCourseId]);

  useEffect(() => {
    const courseId = selectedCourseId.trim();
    if (!courseId) return;
    if (selectedCourse?.program?.trim()) return;
    if (Object.prototype.hasOwnProperty.call(courseProgramsByCourse, courseId)) return;

    let cancelled = false;
    const loadCourseProgram = async () => {
      try {
        const courseSnap = await getDoc(doc(db, "courses", courseId));
        if (cancelled) return;
        const data = courseSnap.data() as { program?: unknown; category?: unknown } | undefined;
        const program =
          typeof data?.program === "string"
            ? data.program.trim()
            : typeof data?.category === "string"
              ? data.category.trim()
              : "";
        setCourseProgramsByCourse((prev) => ({
          ...prev,
          [courseId]: program,
        }));
      } catch (error) {
        if (!isPermissionDeniedError(error)) {
          console.warn("No se pudo cargar el programa de la materia:", error);
        }
        if (!cancelled) {
          setCourseProgramsByCourse((prev) => ({
            ...prev,
            [courseId]: "",
          }));
        }
      }
    };
    void loadCourseProgram();
    return () => {
      cancelled = true;
    };
  }, [courseProgramsByCourse, selectedCourse?.program, selectedCourseId]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const nextStudents = (await getGroupStudents(groupId)).map((student) => ({
          id: student.id,
          name: student.studentName ?? "",
        }));
        const studentIdSet = new Set(nextStudents.map((student) => student.id));

        let permissionWarningShown = false;
        let submissions: Submission[] = [];
        try {
          submissions = await getAllSubmissions(groupId);
        } catch (error) {
          if (isPermissionDeniedError(error)) {
            permissionWarningShown = true;
            console.warn("Sin permisos para leer submissions del grupo:", groupId, error);
          } else {
            throw error;
          }
        }

        let enrollmentDocs: Array<{ __id: string; [key: string]: unknown }> = [];
        try {
          const token = await auth.currentUser?.getIdToken();
          if (!token) {
            throw new Error("No se pudo obtener el token de sesión");
          }
          const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/student-enrollments`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            cache: "no-store",
          });
          const payload = (await response.json().catch(() => ({}))) as StudentEnrollmentsApiResponse;
          if (!response.ok || payload.success === false) {
            throw new Error(payload.error ?? "No se pudieron cargar las inscripciones del grupo");
          }
          enrollmentDocs = (payload.data?.enrollments ?? []) as Array<{ __id: string; [key: string]: unknown }>;
        } catch (error) {
          permissionWarningShown = true;
          console.warn("No se pudieron cargar studentEnrollments del grupo:", groupId, error);
        }

        const enrollmentsMap: Record<string, EnrollmentRecord> = {};
        enrollmentDocs.forEach((enrollmentRaw) => {
          const data = enrollmentRaw as {
            __id: string;
            studentId?: string;
            studentName?: string;
            courseClosures?: Record<string, unknown>;
            [key: string]: unknown;
          };
          const enrollmentDocId = data.__id;
          const idFromDoc = enrollmentDocId.startsWith(`${groupId}_`)
            ? enrollmentDocId.slice(groupId.length + 1).trim()
            : "";
          const studentId =
            (typeof data.studentId === "string" ? data.studentId.trim() : "") || idFromDoc;
          if (!studentId) return;
          const canonicalId = `${groupId}_${studentId}`;
          const existing = enrollmentsMap[studentId];
          if (existing && existing.id === canonicalId) return;

          const rawClosures: Record<string, unknown> = {
            ...((data.courseClosures ?? {}) as Record<string, unknown>),
          };
          Object.entries(data).forEach(([key, value]) => {
            if (!key.startsWith("courseClosures.")) return;
            const legacyCourseId = key.slice("courseClosures.".length).trim();
            if (!legacyCourseId) return;
            if (!Object.prototype.hasOwnProperty.call(rawClosures, legacyCourseId)) {
              rawClosures[legacyCourseId] = value;
            }
          });
          const normalizedClosures: Record<string, CourseClosureState> = {};
          Object.entries(rawClosures).forEach(([courseId, closureValue]) => {
            if (!closureValue || typeof closureValue !== "object") return;
            const closureObj = closureValue as Record<string, unknown>;
            const normalizedExtraConcepts = normalizeExtraConcepts(
              closureObj.extraConcepts,
              courseId,
            );
            const extraPointsTotal = Math.round(
              normalizedExtraConcepts.reduce((acc, entry) => acc + entry.points, 0) * 10,
            ) / 10;
            normalizedClosures[courseId] = {
              status:
                closureObj.status === "closed" || closureObj.status === "open"
                  ? (closureObj.status as "closed" | "open")
                  : undefined,
              finalGrade:
                typeof closureObj.finalGrade === "number" && Number.isFinite(closureObj.finalGrade)
                  ? closureObj.finalGrade
                  : undefined,
              autoGrade:
                typeof closureObj.autoGrade === "number" && Number.isFinite(closureObj.autoGrade)
                  ? closureObj.autoGrade
                  : null,
              campusTasksGrade:
                typeof closureObj.campusTasksGrade === "number" &&
                Number.isFinite(closureObj.campusTasksGrade)
                  ? closureObj.campusTasksGrade
                  : null,
              campusFinalExamGrade:
                typeof closureObj.campusFinalExamGrade === "number" &&
                Number.isFinite(closureObj.campusFinalExamGrade)
                  ? closureObj.campusFinalExamGrade
                  : null,
              globalExamGrade:
                typeof closureObj.globalExamGrade === "number" &&
                Number.isFinite(closureObj.globalExamGrade)
                  ? closureObj.globalExamGrade
                  : null,
              extraordinaryExamGrade:
                typeof closureObj.extraordinaryExamGrade === "number" &&
                Number.isFinite(closureObj.extraordinaryExamGrade)
                  ? closureObj.extraordinaryExamGrade
                  : null,
              extraConcepts: normalizedExtraConcepts,
              extraPointsTotal,
              manualOverride: closureObj.manualOverride === true,
              pendingUngradedCount:
                typeof closureObj.pendingUngradedCount === "number"
                  ? closureObj.pendingUngradedCount
                  : undefined,
              closedByType:
                closureObj.closedByType === "teacher" || closureObj.closedByType === "system"
                  ? closureObj.closedByType
                  : undefined,
              closureTrigger:
                closureObj.closureTrigger === "manual" || closureObj.closureTrigger === "automatic"
                  ? closureObj.closureTrigger
                  : undefined,
              lastFinalGradeNotifiedAt: toDateOrNull(closureObj.lastFinalGradeNotifiedAt),
              lastFinalGradeNotifiedBy:
                typeof closureObj.lastFinalGradeNotifiedBy === "string"
                  ? closureObj.lastFinalGradeNotifiedBy
                  : undefined,
              lastFinalGradeNotifiedValue:
                typeof closureObj.lastFinalGradeNotifiedValue === "number" &&
                Number.isFinite(closureObj.lastFinalGradeNotifiedValue)
                  ? closureObj.lastFinalGradeNotifiedValue
                  : undefined,
              closedAt: toDateOrNull(closureObj.closedAt),
              closedById: typeof closureObj.closedById === "string" ? closureObj.closedById : undefined,
              closedByName:
                typeof closureObj.closedByName === "string" ? closureObj.closedByName : undefined,
              reopenedAt: toDateOrNull(closureObj.reopenedAt),
              reopenedById:
                typeof closureObj.reopenedById === "string" ? closureObj.reopenedById : undefined,
              reopenedByName:
                typeof closureObj.reopenedByName === "string" ? closureObj.reopenedByName : undefined,
              updatedAt: toDateOrNull(closureObj.updatedAt),
            };
          });

          const record: EnrollmentRecord = {
            id: enrollmentDocId,
            courseClosures: normalizedClosures,
            studentName: data.studentName,
          };

          if (!existing || enrollmentDocId === canonicalId) {
            enrollmentsMap[studentId] = record;
          }
        });

        const forumClasses: Array<{
          courseId: string;
          lessonId: string;
          classId: string;
          className: string;
        }> = [];

        const courseTasksEntries = await Promise.all(
          courses.map(async (course) => {
            const lessonsSnap = await getDocs(
              query(collection(db, "courses", course.courseId, "lessons"), orderBy("order", "asc")),
            );
            const tasks: Task[] = [];
            for (const lesson of lessonsSnap.docs) {
              const classesSnap = await getDocs(
                query(
                  collection(db, "courses", course.courseId, "lessons", lesson.id, "classes"),
                  orderBy("order", "asc"),
                ),
              );
              classesSnap.forEach((cls) => {
                const data = cls.data() as {
                  type?: string;
                  hasAssignment?: boolean;
                  forumEnabled?: boolean;
                  title?: string;
                };
                const evaluable = data.type === "quiz" || data.hasAssignment === true || data.forumEnabled === true;
                if (!evaluable) return;
                tasks.push({
                  id: cls.id,
                  lessonId: lesson.id,
                  title: data.title ?? "Sin título",
                  classType:
                    data.forumEnabled === true
                      ? "forum"
                      : data.type === "quiz"
                      ? "quiz"
                      : data.hasAssignment === true
                      ? "assignment"
                      : "activity",
                });
                if (data.forumEnabled === true) {
                  forumClasses.push({
                    courseId: course.courseId,
                    lessonId: lesson.id,
                    classId: cls.id,
                    className: data.title ?? "Sin título",
                  });
                }
              });
            }
            return [course.courseId, tasks] as const;
          }),
        );

        const forumSubmissionsByClass = await Promise.all(
          forumClasses.map(async (forumClass) => {
            try {
              const posts = await getForumPosts(
                forumClass.courseId,
                forumClass.lessonId,
                forumClass.classId,
              );
              return posts
                .map((post): Submission | null => {
                  const authorId = (post.authorId ?? "").trim() || post.id;
                  if (!authorId || !studentIdSet.has(authorId)) return null;
                  return {
                    id: post.id,
                    classId: forumClass.classId,
                    classDocId: forumClass.classId,
                    courseId: forumClass.courseId,
                    className: forumClass.className,
                    classType: "forum",
                    studentId: authorId,
                    studentName: post.authorName ?? "",
                    submittedAt: post.createdAt ?? null,
                    fileUrl: post.mediaUrl ?? "",
                    content: post.text ?? "",
                    status:
                      post.status === "graded" || typeof post.grade === "number"
                        ? "graded"
                        : "pending",
                    grade: typeof post.grade === "number" ? post.grade : undefined,
                    feedback: post.feedback ?? "",
                    gradedAt: post.gradedAt ?? null,
                    gradedById: post.gradedById ?? undefined,
                    gradedByName: post.gradedByName ?? undefined,
                  };
                })
                .filter((submission): submission is Submission => submission !== null);
            } catch (error) {
              console.warn(
                `No se pudieron cargar aportes de foro para ${forumClass.courseId}/${forumClass.lessonId}/${forumClass.classId}`,
                error,
              );
              return [];
            }
          }),
        );
        const mergedSubmissions = [...submissions, ...forumSubmissionsByClass.flat()];

        if (cancelled) return;
        setStudents(nextStudents);
        setAllSubmissions(mergedSubmissions);
        setEnrollmentByStudent(enrollmentsMap);
        setTasksByCourse(Object.fromEntries(courseTasksEntries));
        if (permissionWarningShown) {
          toast.error("Algunas calificaciones no pudieron cargarse por permisos del rol.");
        }
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar las calificaciones");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [courses, groupId, userRole]);

  const selectedCourseTasks = useMemo(() => {
    if (!selectedCourseId) return [];
    return tasksByCourse[selectedCourseId] ?? [];
  }, [selectedCourseId, tasksByCourse]);

  useEffect(() => {
    let cancelled = false;

    const loadQuizConfig = async () => {
      if (!selectedCourseId) {
        setQuizConfigByClass({});
        return;
      }
      const quizTasks = selectedCourseTasks.filter((task) => task.classType === "quiz");
      if (quizTasks.length === 0) {
        setQuizConfigByClass({});
        return;
      }

      try {
        const entries = await Promise.all(
          quizTasks.map(async (task) => {
            const questionsSnap = await getDocs(
              collection(
                db,
                "courses",
                selectedCourseId,
                "lessons",
                task.lessonId,
                "classes",
                task.id,
                "questions",
              ),
            );

            let totalPoints = 0;
            const questionsById: Record<string, QuizQuestionConfig> = {};

            questionsSnap.docs.forEach((questionDoc) => {
              const data = questionDoc.data() as {
                pointValue?: unknown;
                options?: unknown[];
              };
              const pointValue = normalizeQuizPointValue(data.pointValue);
              totalPoints = Math.round((totalPoints + pointValue) * 100) / 100;

              const correctOptionIds = Array.isArray(data.options)
                ? data.options
                    .map((opt) => {
                      const option = (opt && typeof opt === "object"
                        ? opt
                        : {}) as {
                        id?: unknown;
                        text?: unknown;
                        isCorrect?: unknown;
                      };
                      if (option.isCorrect !== true) return "";
                      if (typeof option.id === "string" && option.id.trim().length > 0) {
                        return option.id.trim();
                      }
                      if (typeof option.text === "string" && option.text.trim().length > 0) {
                        return option.text.trim();
                      }
                      return "";
                    })
                    .filter((id): id is string => id.length > 0)
                : [];

              questionsById[questionDoc.id] = {
                pointValue,
                correctOptionIds,
              };
            });

            return [
              task.id,
              {
                totalPoints,
                questionsById,
              } satisfies QuizClassConfig,
            ] as const;
          }),
        );

        if (cancelled) return;
        setQuizConfigByClass(Object.fromEntries(entries));
      } catch (error) {
        console.warn("No se pudo cargar configuración de quizzes para recálculo dinámico:", error);
        if (!cancelled) {
          setQuizConfigByClass({});
        }
      }
    };

    void loadQuizConfig();
    return () => {
      cancelled = true;
    };
  }, [selectedCourseId, selectedCourseTasks]);

  const rows = useMemo<StudentCourseRow[]>(() => {
    if (!selectedCourseId) return [];
    const classIdSet = new Set(selectedCourseTasks.map((t) => t.id));

    return students.map((student) => {
      const latestByClass = new Map<string, Submission>();
      allSubmissions.forEach((submission) => {
        if (submission.studentId !== student.id) return;
        if ((submission.courseId ?? "") !== selectedCourseId) return;
        const classId = (submission.classDocId ?? submission.classId ?? "").trim();
        if (!classId || !classIdSet.has(classId)) return;
        const current = latestByClass.get(classId);
        if (!current) {
          latestByClass.set(classId, submission);
          return;
        }
        if (shouldPreferIncomingSubmission(current, submission)) {
          latestByClass.set(classId, submission);
        }
      });

      const latestSubmissions = Array.from(latestByClass.values());
      const gradedSubmissions = latestSubmissions.filter(
        (sub) => sub.status === "graded" || hasNumericSubmissionGrade(sub),
      );
      const normalizeTaskGrade = (task: Task, submission?: Submission): number | null => {
        if (!submission) {
          return null;
        }
        const rawGrade =
          hasNumericSubmissionGrade(submission) ? submission.grade : null;
        if (task.classType !== "quiz") {
          return rawGrade === null ? null : Math.round(rawGrade * 10) / 10;
        }

        const quizConfig = quizConfigByClass[task.id];
        const answers = Array.isArray(submission.answers) ? submission.answers : [];

        // Recalcular directamente con la configuración actual del quiz.
        if (quizConfig && answers.length > 0) {
          let matchedQuestions = 0;
          let earnedPoints = 0;
          answers.forEach((answer) => {
            const questionId = typeof answer.questionId === "string" ? answer.questionId.trim() : "";
            if (!questionId) return;
            const questionConfig = quizConfig.questionsById[questionId];
            if (!questionConfig) return;
            matchedQuestions += 1;
            const selectedOptionId =
              typeof answer.selectedOptionId === "string" ? answer.selectedOptionId.trim() : "";
            if (!selectedOptionId) return;
            if (questionConfig.correctOptionIds.includes(selectedOptionId)) {
              earnedPoints += questionConfig.pointValue;
            }
          });
          if (matchedQuestions > 0) {
            return Math.round(earnedPoints * 10) / 10;
          }
        }

        if (rawGrade === null) {
          return null;
        }

        // Fallback proporcional si ya no se pueden mapear IDs de preguntas/opciones.
        const answersCount = Array.isArray(submission.answers) ? submission.answers.length : 0;
        const quizPointsMaxFromAnswers = answers.length > 0
          ? Math.round(
              answers.reduce((sum, answer) => {
                return sum + normalizeQuizPointValue(answer.questionPointValue);
              }, 0) * 100,
            ) / 100
          : 0;
        const historicalQuizPointsMax =
          quizPointsMaxFromAnswers > 0 ? quizPointsMaxFromAnswers : answersCount;

        if (historicalQuizPointsMax <= 0) {
          return Math.round(rawGrade * 10) / 10;
        }

        const currentQuizPointsMax =
          quizConfig && quizConfig.totalPoints > 0 ? quizConfig.totalPoints : historicalQuizPointsMax;

        // Compatibilidad: quizzes antiguos se guardaban como porcentaje 0-100.
        const looksLikeLegacyPercent =
          rawGrade <= 100 &&
          (rawGrade > historicalQuizPointsMax || historicalQuizPointsMax > 100);
        const ratio = looksLikeLegacyPercent
          ? rawGrade / 100
          : rawGrade / historicalQuizPointsMax;
        if (!Number.isFinite(ratio)) {
          return Math.round(rawGrade * 10) / 10;
        }
        return Math.round(ratio * currentQuizPointsMax * 10) / 10;
      };
      const autoBreakdown = selectedCourseTasks.map<AutoBreakdownEntry>((task) => {
        const matched = latestByClass.get(task.id);
        const normalizedGrade = normalizeTaskGrade(task, matched);
        return {
          classId: task.id,
          classTitle: task.title,
          classType: task.classType,
          grade: normalizedGrade,
          hasSubmission: Boolean(matched),
          isMarkedGraded: matched?.status === "graded",
          submissionId: matched?.id,
          submittedAt: matched?.submittedAt ?? null,
          gradedAt: matched?.gradedAt ?? null,
          gradedById: matched?.gradedById,
          gradedByName: matched?.gradedByName,
        };
      });
      const numericBreakdownGrades = autoBreakdown
        .map((item) => item.grade)
        .filter((grade): grade is number => typeof grade === "number" && Number.isFinite(grade));
      const autoGrade =
        numericBreakdownGrades.length > 0
          ? Math.round(numericBreakdownGrades.reduce((acc, grade) => acc + grade, 0) * 10) / 10
          : null;
      const pendingUngradedCount = Math.max(selectedCourseTasks.length - gradedSubmissions.length, 0);

      const enrollment = enrollmentByStudent[student.id];
      const closure = enrollment?.courseClosures?.[selectedCourseId] ?? null;

      return {
        studentId: student.id,
        studentName: student.name,
        enrollmentId: enrollment?.id ?? `${groupId}_${student.id}`,
        autoGrade,
        autoBreakdown,
        pendingUngradedCount,
        gradedCount: gradedSubmissions.length,
        totalEvaluable: selectedCourseTasks.length,
        closure,
      };
    });
  }, [allSubmissions, enrollmentByStudent, groupId, quizConfigByClass, selectedCourseId, selectedCourseTasks, students]);

  const openRowsCount = useMemo(
    () => rows.filter((row) => row.closure?.status !== "closed").length,
    [rows],
  );

  const breakdownRow = useMemo(
    () => (breakdownStudentId ? rows.find((row) => row.studentId === breakdownStudentId) ?? null : null),
    [breakdownStudentId, rows],
  );

  useEffect(() => {
    if (!breakdownStudentId) return;
    if (rows.some((row) => row.studentId === breakdownStudentId)) return;
    setBreakdownStudentId(null);
  }, [breakdownStudentId, rows]);

  const fetchConceptSuggestions = useCallback(async (): Promise<string[]> => {
    let suggestionsDocs: Array<{ data: () => unknown }> = [];
    try {
      const suggestionsSnap = await getDocs(query(collection(db, "gradeConceptSuggestions"), limit(400)));
      suggestionsDocs = suggestionsSnap.docs;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        return [];
      }
      throw error;
    }

    const extrasByCourse = await Promise.all(
      courses.map(async (course) => {
        const courseId = course.courseId?.trim() ?? "";
        if (!courseId) return [] as ExtraConceptDefinition[];
        try {
          const extrasSnap = await getDoc(
            doc(db, "groups", groupId, "grades", getCourseExtrasDocId(courseId)),
          );
          if (!extrasSnap.exists()) return [] as ExtraConceptDefinition[];
          const extrasData = extrasSnap.data() as { extraConcepts?: unknown };
          return normalizeExtraConceptDefinitions(extrasData.extraConcepts, courseId);
        } catch (error) {
          if (isPermissionDeniedError(error)) return [] as ExtraConceptDefinition[];
          return [] as ExtraConceptDefinition[];
        }
      }),
    );

    const rankedSuggestions = [
      ...suggestionsDocs
        .map((docSnap) => {
          const data = docSnap.data() as { concept?: unknown; usageCount?: unknown };
          const concept = typeof data.concept === "string" ? data.concept.trim() : "";
          const usageCount =
            typeof data.usageCount === "number" && Number.isFinite(data.usageCount) ? data.usageCount : 0;
          if (!concept) return null;
          const normalized = toConceptComparable(concept);
          if (!normalized) return null;
          return { concept, normalized, usageCount };
        })
        .filter(
          (
            entry,
          ): entry is {
            concept: string;
            normalized: string;
            usageCount: number;
          } => entry !== null,
        ),
      ...extrasByCourse
        .flat()
        .map((entry) => {
          const concept = entry.concept.trim();
          if (!concept) return null;
          const normalized = toConceptComparable(concept);
          if (!normalized) return null;
          return { concept, normalized, usageCount: 0 };
        })
        .filter(
          (
            entry,
          ): entry is {
            concept: string;
            normalized: string;
            usageCount: number;
          } => entry !== null,
        ),
    ].sort((left, right) => {
      if (right.usageCount !== left.usageCount) return right.usageCount - left.usageCount;
      return left.concept.localeCompare(right.concept, "es-MX");
    });

    const seen = new Set<string>();
    return rankedSuggestions
      .filter((entry) => {
        if (seen.has(entry.normalized)) return false;
        seen.add(entry.normalized);
        return true;
      })
      .slice(0, 120)
      .map((entry) => entry.concept);
  }, [courses, groupId]);

  useEffect(() => {
    let cancelled = false;
    const loadConceptSuggestions = async () => {
      try {
        const suggestions = await fetchConceptSuggestions();
        if (cancelled) return;
        setExtraConceptSuggestions(suggestions);
      } catch (error) {
        if (!isPermissionDeniedError(error)) {
          console.warn("No se pudieron cargar sugerencias de conceptos extra:", error);
        }
      }
    };
    void loadConceptSuggestions();
    return () => {
      cancelled = true;
    };
  }, [fetchConceptSuggestions]);

  const getDraftKey = (studentId: string) => `${selectedCourseId}::${studentId}`;
  const formatGradeInput = (value?: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "";
  const parseOptionalGradeInput = (value: string): number | null | undefined => {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
    return parsed;
  };
  const parseOptionalExtraPointsInput = (value: string): number | null | undefined => {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return parsed;
  };

  const roundGrade = (value: number) => Math.round(value * 10) / 10;
  const getCourseExtraDraftKey = () => selectedCourseId.trim();
  const selectedCourseExamTemplates = selectedCourseId
    ? courseExamTemplatesByCourse[selectedCourseId] ?? {}
    : {};
  const selectedExistingGlobalExamTemplate = selectedCourseId
    ? existingGlobalExamTemplatesByCourse[selectedCourseId]
    : null;
  const hasLinkedGlobalExamTemplate = Boolean(selectedExistingGlobalExamTemplate);
  const hasGlobalExamTemplateForClosure =
    hasLinkedGlobalExamTemplate ||
    Boolean(selectedCourseExamTemplates.global);
  const hasRequiredExamTemplates =
    selectedCourseSkipsExamTemplates ||
    (
      hasGlobalExamTemplateForClosure &&
      Boolean(selectedCourseExamTemplates.extraordinary)
    );
  const missingRequiredExamTemplateLabels = [
    selectedCourseSkipsExamTemplates || selectedCourseExamTemplates.extraordinary
      ? ""
      : EXAM_TEMPLATE_KIND_LABELS.extraordinary,
    selectedCourseSkipsExamTemplates || hasGlobalExamTemplateForClosure
      ? ""
      : EXAM_TEMPLATE_KIND_LABELS.global,
  ].filter((label): label is string => label.length > 0);

  const validateExamTemplateFile = (file: File): string | null => {
    if (!isWordExamTemplateFile(file)) return "Sube un archivo Word .doc o .docx.";
    if (file.size > MAX_EXAM_TEMPLATE_FILE_SIZE) return "El archivo no debe superar 25 MB.";
    return null;
  };

  const getCourseExtraConceptDrafts = (): ExtraConceptDraft[] => {
    const key = getCourseExtraDraftKey();
    if (!key) return [];
    if (Object.prototype.hasOwnProperty.call(draftExtraConceptsByCourse, key)) {
      return draftExtraConceptsByCourse[key];
    }
    return [];
  };

  const resolveCourseConceptsFromDrafts = (drafts: ExtraConceptDraft[]): CourseConceptsResolution => {
    const usedConceptKeys = new Set<string>();
    const parsedConcepts: ExtraConceptDefinition[] = [];
    for (const draft of drafts) {
      const concept = draft.concept.trim();
      if (!concept) continue;
      const conceptKey = toConceptComparable(concept);
      if (!conceptKey) {
        return {
          concepts: [],
          errorMessage: "El concepto extra no puede estar vacío.",
        };
      }
      if (usedConceptKeys.has(conceptKey)) {
        return {
          concepts: [],
          errorMessage: "No repitas el mismo concepto extra en la materia.",
        };
      }
      usedConceptKeys.add(conceptKey);
      const parsedDefaultPoints = parseOptionalExtraPointsInput(draft.defaultPoints);
      if (parsedDefaultPoints === undefined) {
        return {
          concepts: [],
          errorMessage: `El puntaje inicial para \"${concept}\" debe ser 0 o mayor.`,
        };
      }
      parsedConcepts.push({
        id: draft.id || createExtraConceptId(),
        concept,
        defaultPoints: parsedDefaultPoints === null ? null : roundGrade(parsedDefaultPoints),
      });
    }

    return {
      concepts: parsedConcepts,
      errorMessage: null,
    };
  };

  const resolveExtraConceptsForCourse = (): CourseConceptsResolution =>
    resolveCourseConceptsFromDrafts(getCourseExtraConceptDrafts());

  useEffect(() => {
    if (!selectedCourseId) return;
    let cancelled = false;
    const key = selectedCourseId.trim();
    const loadCourseExtraConcepts = async () => {
      try {
        const courseExtrasRef = doc(
          db,
          "groups",
          groupId,
          "grades",
          getCourseExtrasDocId(selectedCourseId),
        );
        const courseExtrasSnap = await getDoc(courseExtrasRef);
        if (cancelled) return;

        let concepts: ExtraConceptDefinition[] = [];
        let examTemplates: CourseExamTemplates = {};
        if (courseExtrasSnap.exists()) {
          const data = courseExtrasSnap.data() as {
            extraConcepts?: unknown;
            examTemplates?: unknown;
          };
          concepts = normalizeExtraConceptDefinitions(data.extraConcepts, selectedCourseId);
          examTemplates = normalizeCourseExamTemplates(data.examTemplates);
        }

        if (concepts.length === 0) {
          const fallbackMap = new Map<string, ExtraConceptDefinition>();
          rows.forEach((row) => {
            (row.closure?.extraConcepts ?? []).forEach((extraConcept) => {
              const conceptKey = toConceptComparable(extraConcept.concept);
              if (!conceptKey || fallbackMap.has(conceptKey)) return;
              fallbackMap.set(conceptKey, {
                id: extraConcept.id,
                concept: extraConcept.concept,
                defaultPoints: null,
              });
            });
          });
          concepts = Array.from(fallbackMap.values());
        }

        setDraftExtraConceptsByCourse((prev) => ({
          ...prev,
          [key]: toExtraConceptDrafts(concepts),
        }));
        setCourseExamTemplatesByCourse((prev) => ({
          ...prev,
          [key]: examTemplates,
        }));
      } catch (error) {
        if (!isPermissionDeniedError(error)) {
          console.warn("No se pudieron cargar los extras globales de la materia:", error);
        }
      }
    };
    void loadCourseExtraConcepts();
    return () => {
      cancelled = true;
    };
  }, [groupId, rows, selectedCourseId]);

  const getClosureExtraPointsForConcept = (
    row: StudentCourseRow,
    concept: ExtraConceptDefinition,
  ): number | null => {
    const closureExtras = row.closure?.extraConcepts ?? [];
    const byId = closureExtras.find((item) => item.id === concept.id);
    if (byId && Number.isFinite(byId.points)) return roundGrade(byId.points);
    const conceptKey = toConceptComparable(concept.concept);
    const byConcept = closureExtras.find((item) => toConceptComparable(item.concept) === conceptKey);
    if (byConcept && Number.isFinite(byConcept.points)) return roundGrade(byConcept.points);
    return null;
  };

  const getExtraPointInputForRow = (row: StudentCourseRow, concept: ExtraConceptDefinition): string => {
    const rowKey = getDraftKey(row.studentId);
    const rowDraft = draftExtraPointsByStudent[rowKey];
    if (rowDraft && Object.prototype.hasOwnProperty.call(rowDraft, concept.id)) {
      return rowDraft[concept.id];
    }
    const closurePoints = getClosureExtraPointsForConcept(row, concept);
    if (typeof closurePoints === "number") {
      return formatGradeInput(closurePoints);
    }
    if (typeof concept.defaultPoints === "number" && Number.isFinite(concept.defaultPoints)) {
      return formatGradeInput(roundGrade(concept.defaultPoints));
    }
    return "";
  };

  const updateExtraPointInputForRow = (
    row: StudentCourseRow,
    concept: ExtraConceptDefinition,
    value: string,
  ) => {
    const rowKey = getDraftKey(row.studentId);
    setDraftExtraPointsByStudent((prev) => ({
      ...prev,
      [rowKey]: {
        ...(prev[rowKey] ?? {}),
        [concept.id]: value,
      },
    }));
  };

  const resolveExtraConceptsForRow = (
    row: StudentCourseRow,
    concepts: ExtraConceptDefinition[],
  ): ExtraConceptResolution => {
    const parsedConcepts: ExtraConceptGrade[] = [];
    for (const concept of concepts) {
      const inputValue = getExtraPointInputForRow(row, concept);
      const parsedValue = parseOptionalExtraPointsInput(inputValue);
      if (parsedValue === undefined) {
        return {
          concepts: [],
          totalPoints: 0,
          errorMessage: `El puntaje extra para \"${concept.concept}\" debe ser 0 o mayor.`,
        };
      }
      const points = parsedValue === null ? 0 : roundGrade(parsedValue);
      parsedConcepts.push({
        id: concept.id,
        concept: concept.concept,
        points,
      });
    }

    return {
      concepts: parsedConcepts,
      totalPoints: roundGrade(parsedConcepts.reduce((acc, entry) => acc + entry.points, 0)),
      errorMessage: null,
    };
  };

  const areNullableGradesEqual = (a?: number | null, b?: number | null) => {
    const normalizedA = typeof a === "number" && Number.isFinite(a) ? roundGrade(a) : null;
    const normalizedB = typeof b === "number" && Number.isFinite(b) ? roundGrade(b) : null;
    return normalizedA === normalizedB;
  };

  const areExtraConceptsEquivalent = (
    a?: ExtraConceptGrade[] | null,
    b?: ExtraConceptGrade[] | null,
  ) => {
    const normalize = (items?: ExtraConceptGrade[] | null) =>
      (items ?? [])
        .map((item) => ({
          key: toConceptComparable(item.concept),
          points: roundGrade(item.points),
        }))
        .filter((item) => item.key.length > 0)
        .sort((left, right) => left.key.localeCompare(right.key));
    const left = normalize(a);
    const right = normalize(b);
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index].key !== right[index].key) return false;
      if (!areNullableGradesEqual(left[index].points, right[index].points)) return false;
    }
    return true;
  };

  const getCampusTasksGradeInput = (row: StudentCourseRow) => {
    if (!enableCampusTasksGrade) return "";
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftCampusTasksGrades, key)) {
      return draftCampusTasksGrades[key];
    }
    return formatGradeInput(row.closure?.campusTasksGrade);
  };

  const getCampusFinalExamGradeInput = (row: StudentCourseRow) => {
    if (!enableCampusFinalExamGrade) return "";
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftCampusFinalExamGrades, key)) {
      return draftCampusFinalExamGrades[key];
    }
    return formatGradeInput(row.closure?.campusFinalExamGrade);
  };

  const getGlobalExamGradeInput = (row: StudentCourseRow) => {
    if (!enableGlobalExamGrade) return "";
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftGlobalExamGrades, key)) {
      return draftGlobalExamGrades[key];
    }
    return formatGradeInput(row.closure?.globalExamGrade);
  };

  const getExtraordinaryExamGradeInput = (row: StudentCourseRow) => {
    if (!enableExtraordinaryExamGrade) return "";
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftExtraordinaryExamGrades, key)) {
      return draftExtraordinaryExamGrades[key];
    }
    return formatGradeInput(row.closure?.extraordinaryExamGrade);
  };

  const resolveCampusGradesForRow = (row: StudentCourseRow) => {
    const parsedCampusTasksGrade = enableCampusTasksGrade
      ? parseOptionalGradeInput(getCampusTasksGradeInput(row))
      : row.closure?.campusTasksGrade ?? null;
    if (enableCampusTasksGrade && parsedCampusTasksGrade === undefined) {
      return {
        campusTasksGrade: null,
        campusFinalExamGrade: null,
        globalExamGrade: null,
        extraordinaryExamGrade: null,
        errorMessage: "La calificación de tareas en plantel debe estar entre 0 y 100.",
      };
    }

    const parsedCampusFinalExamGrade = enableCampusFinalExamGrade
      ? parseOptionalGradeInput(getCampusFinalExamGradeInput(row))
      : row.closure?.campusFinalExamGrade ?? null;
    if (enableCampusFinalExamGrade && parsedCampusFinalExamGrade === undefined) {
      return {
        campusTasksGrade: null,
        campusFinalExamGrade: null,
        globalExamGrade: null,
        extraordinaryExamGrade: null,
        errorMessage: "La calificación de examen final en plantel debe estar entre 0 y 100.",
      };
    }

    const parsedGlobalExamGrade = enableGlobalExamGrade
      ? parseOptionalGradeInput(getGlobalExamGradeInput(row))
      : row.closure?.globalExamGrade ?? null;
    if (enableGlobalExamGrade && parsedGlobalExamGrade === undefined) {
      return {
        campusTasksGrade: null,
        campusFinalExamGrade: null,
        globalExamGrade: null,
        extraordinaryExamGrade: null,
        errorMessage: "La calificación de examen global debe estar entre 0 y 100.",
      };
    }

    const parsedExtraordinaryExamGrade = enableExtraordinaryExamGrade
      ? parseOptionalGradeInput(getExtraordinaryExamGradeInput(row))
      : row.closure?.extraordinaryExamGrade ?? null;
    if (enableExtraordinaryExamGrade && parsedExtraordinaryExamGrade === undefined) {
      return {
        campusTasksGrade: null,
        campusFinalExamGrade: null,
        globalExamGrade: null,
        extraordinaryExamGrade: null,
        errorMessage: "La calificación de examen extraordinario debe estar entre 0 y 100.",
      };
    }

    return {
      campusTasksGrade: parsedCampusTasksGrade ?? null,
      campusFinalExamGrade: parsedCampusFinalExamGrade ?? null,
      globalExamGrade: parsedGlobalExamGrade ?? null,
      extraordinaryExamGrade: parsedExtraordinaryExamGrade ?? null,
      errorMessage: null,
    };
  };

  const resolveFinalGradeForRow = (row: StudentCourseRow) => {
    const campusGrades = resolveCampusGradesForRow(row);
    const courseConceptsResolution = resolveExtraConceptsForCourse();
    const extraConceptsResolution = resolveExtraConceptsForRow(row, courseConceptsResolution.concepts);
    if (campusGrades.errorMessage) {
      return {
        finalGrade: null,
        manualOverride: false,
        campusGrades,
        extraConcepts: [],
        extraPointsTotal: 0,
        errorMessage: campusGrades.errorMessage,
      };
    }
    if (courseConceptsResolution.errorMessage) {
      return {
        finalGrade: null,
        manualOverride: false,
        campusGrades,
        extraConcepts: [],
        extraPointsTotal: 0,
        errorMessage: courseConceptsResolution.errorMessage,
      };
    }
    if (extraConceptsResolution.errorMessage) {
      return {
        finalGrade: null,
        manualOverride: false,
        campusGrades,
        extraConcepts: [],
        extraPointsTotal: 0,
        errorMessage: extraConceptsResolution.errorMessage,
      };
    }

    const key = getDraftKey(row.studentId);
    const hasManualDraft = Object.prototype.hasOwnProperty.call(draftFinalGrades, key);
    if (hasManualDraft) {
      const parsedManual = parseOptionalGradeInput(draftFinalGrades[key]);
      if (parsedManual === undefined) {
        return {
          finalGrade: null,
          manualOverride: false,
          campusGrades,
          extraConcepts: extraConceptsResolution.concepts,
          extraPointsTotal: extraConceptsResolution.totalPoints,
          errorMessage: "La calificación final manual debe estar entre 0 y 100.",
        };
      }
      if (parsedManual !== null) {
        return {
          finalGrade: roundGrade(parsedManual),
          manualOverride: true,
          campusGrades,
          extraConcepts: extraConceptsResolution.concepts,
          extraPointsTotal: extraConceptsResolution.totalPoints,
          errorMessage: null,
        };
      }
    }

    const campusGradesChangedSinceClosure =
      !areNullableGradesEqual(campusGrades.campusTasksGrade, row.closure?.campusTasksGrade) ||
      !areNullableGradesEqual(campusGrades.campusFinalExamGrade, row.closure?.campusFinalExamGrade) ||
      !areNullableGradesEqual(campusGrades.globalExamGrade, row.closure?.globalExamGrade) ||
      !areNullableGradesEqual(campusGrades.extraordinaryExamGrade, row.closure?.extraordinaryExamGrade) ||
      !areExtraConceptsEquivalent(extraConceptsResolution.concepts, row.closure?.extraConcepts);

    if (
      row.closure?.manualOverride === true &&
      typeof row.closure.finalGrade === "number" &&
      !campusGradesChangedSinceClosure
    ) {
      const persistedManual = roundGrade(row.closure.finalGrade);
      if (!Number.isFinite(persistedManual) || persistedManual < 0 || persistedManual > 100) {
        return {
          finalGrade: null,
          manualOverride: false,
          campusGrades,
          extraConcepts: extraConceptsResolution.concepts,
          extraPointsTotal: extraConceptsResolution.totalPoints,
          errorMessage: "La calificación final manual almacenada está fuera de rango.",
        };
      }
      return {
        finalGrade: persistedManual,
        manualOverride: true,
        campusGrades,
        extraConcepts: extraConceptsResolution.concepts,
        extraPointsTotal: extraConceptsResolution.totalPoints,
        errorMessage: null,
      };
    }

    const autoFinalGrade = roundGrade(
      (row.autoGrade ?? 0) +
      (campusGrades.campusTasksGrade ?? 0) +
      (campusGrades.campusFinalExamGrade ?? 0) +
      (campusGrades.globalExamGrade ?? 0) +
      (campusGrades.extraordinaryExamGrade ?? 0) +
      extraConceptsResolution.totalPoints,
    );
    if (!Number.isFinite(autoFinalGrade) || autoFinalGrade < 0 || autoFinalGrade > 100) {
      return {
        finalGrade: null,
        manualOverride: false,
        campusGrades,
        extraConcepts: extraConceptsResolution.concepts,
        extraPointsTotal: extraConceptsResolution.totalPoints,
        errorMessage: "La sumatoria de la calificación final debe estar entre 0 y 100.",
      };
    }

    return {
      finalGrade: autoFinalGrade,
      manualOverride: false,
      campusGrades,
      extraConcepts: extraConceptsResolution.concepts,
      extraPointsTotal: extraConceptsResolution.totalPoints,
      errorMessage: null,
    };
  };

  const persistConceptSuggestions = async (concepts: Array<{ concept: string }>) => {
    const deduped = new Map<string, string>();
    concepts.forEach((entry) => {
      const concept = entry.concept.trim();
      const normalized = toConceptComparable(concept);
      if (!concept || !normalized) return;
      if (!deduped.has(normalized)) {
        deduped.set(normalized, concept);
      }
    });
    if (!deduped.size) return;

    const writes = Array.from(deduped.entries()).map(async ([, concept]) => {
      const docId = toConceptSuggestionDocId(concept);
      if (!docId) return;
      await setDoc(
        doc(db, "gradeConceptSuggestions", docId),
        {
          concept,
          conceptNormalized: toConceptComparable(concept),
          usageCount: increment(1),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    });

    try {
      await Promise.all(writes);
      setExtraConceptSuggestions((prev) => {
        const merged = [...prev];
        const seen = new Set(merged.map((item) => toConceptComparable(item)));
        deduped.forEach((concept, normalized) => {
          if (seen.has(normalized)) return;
          seen.add(normalized);
          merged.push(concept);
        });
        return merged;
      });
    } catch (error) {
      if (!isPermissionDeniedError(error)) {
        console.warn("No se pudieron actualizar sugerencias de conceptos extra:", error);
      }
    }
  };

  const persistCourseExtraConcepts = async (concepts: ExtraConceptDefinition[]) => {
    if (!selectedCourseId) return;
    const extrasRef = doc(
      db,
      "groups",
      groupId,
      "grades",
      getCourseExtrasDocId(selectedCourseId),
    );
    await setDoc(
      extrasRef,
      {
        type: "courseExtras",
        courseId: selectedCourseId,
        extraConcepts: concepts.map((concept) => ({
          id: concept.id,
          concept: concept.concept,
          defaultPoints:
            typeof concept.defaultPoints === "number" && Number.isFinite(concept.defaultPoints)
              ? roundGrade(concept.defaultPoints)
              : null,
        })),
        updatedBy: currentUserId ?? null,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    setDraftExtraConceptsByCourse((prev) => ({
      ...prev,
      [selectedCourseId]: toExtraConceptDrafts(concepts),
    }));
  };

  const toPersistableExamTemplate = (template: CourseExamTemplate) => ({
    kind: template.kind,
    fileName: template.fileName,
    fileSize: template.fileSize,
    contentType: template.contentType,
    storagePath: template.storagePath,
    downloadUrl: template.downloadUrl,
    uploadedAt: template.uploadedAt ?? new Date(),
    uploadedById: template.uploadedById,
    uploadedByName: template.uploadedByName,
  });

  const persistCourseExamTemplate = async (
    kind: ExamTemplateKind,
    template: CourseExamTemplate,
  ) => {
    if (!selectedCourseId) return;
    const extrasRef = doc(
      db,
      "groups",
      groupId,
      "grades",
      getCourseExtrasDocId(selectedCourseId),
    );
    await setDoc(
      extrasRef,
      {
        type: "courseExtras",
        courseId: selectedCourseId,
        examTemplates: {
          [kind]: toPersistableExamTemplate(template),
        },
        updatedBy: currentUserId ?? null,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    setCourseExamTemplatesByCourse((prev) => ({
      ...prev,
      [selectedCourseId]: {
        ...(prev[selectedCourseId] ?? {}),
        [kind]: template,
      },
    }));
  };

  const fetchExistingGlobalExamTemplate = async (): Promise<GlobalExamTemplateRecord | null> => {
    if (!selectedCourseId) return null;
    if (Object.prototype.hasOwnProperty.call(existingGlobalExamTemplatesByCourse, selectedCourseId)) {
      return existingGlobalExamTemplatesByCourse[selectedCourseId] ?? null;
    }
    const token = await auth.currentUser?.getIdToken();
    if (!token) return null;

    const params = new URLSearchParams({ courseId: selectedCourseId });
    const response = await fetch(
      `/api/groups/${encodeURIComponent(groupId)}/global-exam-template?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );
    const payload = (await response.json().catch(() => ({}))) as GlobalExamTemplateApiResponse;
    if (!response.ok || payload.success !== true) {
      throw new Error(payload.error || "No se pudo obtener el examen global existente.");
    }
    const template = payload.data ?? null;
    setExistingGlobalExamTemplatesByCourse((prev) => ({
      ...prev,
      [selectedCourseId]: template,
    }));
    return template;
  };

  const fetchExistingExtraordinaryExamTemplate = async (): Promise<GlobalExamTemplateRecord | null> => {
    if (!selectedCourseId) return null;
    if (Object.prototype.hasOwnProperty.call(existingExtraordinaryExamTemplatesByCourse, selectedCourseId)) {
      return existingExtraordinaryExamTemplatesByCourse[selectedCourseId] ?? null;
    }
    const token = await auth.currentUser?.getIdToken();
    if (!token) return null;

    const params = new URLSearchParams({
      courseId: selectedCourseId,
      examKind: "extraordinary",
    });
    const response = await fetch(
      `/api/groups/${encodeURIComponent(groupId)}/global-exam-template?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
    );
    const payload = (await response.json().catch(() => ({}))) as GlobalExamTemplateApiResponse;
    if (!response.ok || payload.success !== true) {
      throw new Error(payload.error || "No se pudo obtener el examen extraordinario existente.");
    }
    const template = payload.data ?? null;
    setExistingExtraordinaryExamTemplatesByCourse((prev) => ({
      ...prev,
      [selectedCourseId]: template,
    }));
    return template;
  };

  const ensureExtraordinaryExamAssignmentsForStudents = async (
    candidates: AutoExtraordinaryExamAssignmentCandidate[],
  ): Promise<AutoExtraordinaryExamAssignmentSummary> => {
    const resolvedProgram = selectedCourseSkipsExamTemplates
      ? selectedCourseProgram
      : await resolveSelectedCourseProgram();
    if (isExamOptionalProgram(resolvedProgram)) {
      return {
        candidateCount: 0,
        assignedCount: 0,
        alreadyAssignedCount: 0,
        failedStudentNames: [],
        skippedReason: "none",
      };
    }
    const targetCandidates = candidates.filter(
      ({ finalGrade }) =>
        Number.isFinite(finalGrade) &&
        finalGrade > EXTRAORDINARY_EXAM_AUTO_ASSIGN_MIN_EXCLUSIVE &&
        finalGrade < EXTRAORDINARY_EXAM_AUTO_ASSIGN_MAX_EXCLUSIVE,
    );
    const summary: AutoExtraordinaryExamAssignmentSummary = {
      candidateCount: targetCandidates.length,
      assignedCount: 0,
      alreadyAssignedCount: 0,
      failedStudentNames: [],
      skippedReason: "none",
    };

    if (targetCandidates.length === 0) return summary;

    let templateId = selectedCourseExamTemplates.extraordinary?.structuredTemplateId?.trim() ?? "";
    if (!templateId) {
      try {
        const existingTemplate = await fetchExistingExtraordinaryExamTemplate();
        if (existingTemplate?.status === "published") {
          templateId = existingTemplate.id;
        } else if (existingTemplate) {
          summary.skippedReason = "unpublished-template";
          return summary;
        }
      } catch (error) {
        console.warn("No se pudo cargar la plantilla extraordinaria existente:", error);
      }
    }
    if (!templateId) {
      summary.skippedReason = "no-template";
      return summary;
    }

    for (let index = 0; index < targetCandidates.length; index += EXTRAORDINARY_EXAM_AUTO_ASSIGN_BATCH_SIZE) {
      const chunk = targetCandidates.slice(index, index + EXTRAORDINARY_EXAM_AUTO_ASSIGN_BATCH_SIZE);
      await Promise.all(
        chunk.map(async ({ row }) => {
          try {
            await createGlobalExamAssignment({
              templateId,
              studentId: row.studentId,
              groupId,
              reason: "failed_course",
              enabled: true,
            });
            summary.assignedCount += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            if (message.includes("Ya existe una asignacion")) {
              summary.alreadyAssignedCount += 1;
              return;
            }
            console.warn(`No se pudo asignar examen extraordinario a ${row.studentName}:`, error);
            summary.failedStudentNames.push(row.studentName);
          }
        }),
      );
    }

    return summary;
  };

  const showAutoExtraordinaryExamAssignmentNotice = (summary: AutoExtraordinaryExamAssignmentSummary) => {
    if (summary.candidateCount === 0) return;
    if (summary.skippedReason === "no-template") {
      toast(
        `No se cargó examen extraordinario a ${summary.candidateCount} alumno(s): la plantilla no quedó estructurada para plataforma.`,
      );
      return;
    }
    if (summary.skippedReason === "unpublished-template") {
      toast(`No se cargó examen extraordinario a ${summary.candidateCount} alumno(s): la plantilla no está publicada.`);
      return;
    }
    if (summary.assignedCount > 0) {
      toast.success(`Examen extraordinario activado para ${summary.assignedCount} alumno(s).`);
    }
    if (summary.alreadyAssignedCount > 0) {
      toast(`Examen extraordinario ya estaba activo para ${summary.alreadyAssignedCount} alumno(s).`);
    }
    if (summary.failedStudentNames.length > 0) {
      const names = summary.failedStudentNames.slice(0, 3).join(", ");
      const remaining = summary.failedStudentNames.length > 3 ? ` y ${summary.failedStudentNames.length - 3} más` : "";
      toast.error(`No se pudo activar extraordinario a: ${names}${remaining}.`);
    }
  };

  const renderGlobalExamQuestionsHtml = (template: GlobalExamTemplateRecord | null) => {
    if (!template || template.questions.length === 0) {
      return `
  <p><strong>Tipo admitido:</strong> Opción múltiple</p>
  <p>1. Escribe el enunciado de la pregunta.</p>
  <p>A) Opción A<br />B) Opción B<br />C) Opción C<br />D) Opción D</p>
  <p><strong>Respuesta correcta:</strong> A</p>
  <p><strong>Puntaje:</strong> __ puntos</p>`;
    }

    return template.questions
      .map((question, questionIndex) => {
        const correctIndex = question.options.findIndex((option) => option.id === question.correctOptionId);
        const correctLetter = correctIndex >= 0 ? OPTION_LETTERS[correctIndex] ?? `${correctIndex + 1}` : "";
        const optionsHtml = question.options
          .map((option, optionIndex) => {
            const letter = OPTION_LETTERS[optionIndex] ?? `${optionIndex + 1}`;
            return `${letter}) ${escapeHtml(option.text)}`;
          })
          .join("<br />");
        return `
  <p><strong>Tipo admitido:</strong> Opción múltiple</p>
  <p>${questionIndex + 1}. ${escapeHtml(question.prompt)}</p>
  <p>${optionsHtml}</p>
  <p><strong>Respuesta correcta:</strong> ${escapeHtml(correctLetter)}</p>
  <p><strong>Puntaje:</strong> ${Math.round(1000 / template.questions.length) / 10} puntos</p>`;
      })
      .join("\n");
  };

  const buildExamTemplateExampleHtml = (
    kind: ExamTemplateKind,
    globalTemplate: GlobalExamTemplateRecord | null,
  ) => {
    const courseName = globalTemplate?.courseName || selectedCourse?.courseName || "Materia";
    const title = globalTemplate
      ? `${EXAM_TEMPLATE_KIND_LABELS[kind]} basado en ${globalTemplate.title}`
      : EXAM_TEMPLATE_KIND_LABELS[kind];
    const description = globalTemplate?.description.trim()
      ? globalTemplate.description.trim()
      : "Completa esta plantilla en Word y súbela antes de cerrar calificaciones.";
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; line-height: 1.35; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    h2 { border-bottom: 1px solid #cbd5e1; font-size: 16px; margin-top: 22px; padding-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #94a3b8; padding: 6px; vertical-align: top; }
    th { background: #e2e8f0; }
    .hint { color: #475569; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p><strong>Materia:</strong> ${escapeHtml(courseName)}</p>
  <p class="hint">${escapeHtml(description)}</p>

  <h2>Configuración del Examen</h2>
  <table>
    <tr><th>Campo</th><th>Valor</th></tr>
    <tr><td>Duración</td><td>${GLOBAL_EXAM_DURATION_MINUTES} minutos</td></tr>
    <tr><td>Puntaje mínimo aprobatorio</td><td>${globalTemplate?.passScore ?? 70} / 100</td></tr>
    <tr><td>Número de preguntas</td><td>${globalTemplate?.questionCount ?? "__"}</td></tr>
    <tr><td>Instrucciones para el alumno</td><td>Escribe aquí las instrucciones generales.</td></tr>
  </table>

  <h2>Preguntas</h2>
${renderGlobalExamQuestionsHtml(globalTemplate)}
</body>
</html>`;
  };

  const downloadExamTemplateExample = async (kind: ExamTemplateKind) => {
    let globalTemplate: GlobalExamTemplateRecord | null = null;
    try {
      globalTemplate = await fetchExistingGlobalExamTemplate();
      if (!globalTemplate) {
        toast("No hay examen global cargado para esta materia; se descargará el formato base.");
      }
    } catch (error) {
      console.warn("No se pudo cargar examen global existente para la plantilla:", error);
      toast("No se pudo leer el examen global existente; se descargará el formato base.");
    }

    const html = buildExamTemplateExampleHtml(kind, globalTemplate);
    const blob = new Blob([html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `plantilla-${kind === "global" ? "examen-global" : "examen-extraordinario"}.doc`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const openExamTemplatePreview = async (template: CourseExamTemplate, sourceFile?: File) => {
    setExamTemplatePreview({
      template,
      questions: [],
      loading: true,
      error: null,
    });

    try {
      const file =
        sourceFile ??
        new File(
          [await (await fetch(template.downloadUrl)).blob()],
          template.fileName,
          { type: template.contentType || undefined },
        );
      const questions = await parseExamTemplatePreviewQuestions(file);
      if (questions.length === 0) {
        throw new Error("No se detectaron preguntas con opciones dentro del archivo.");
      }
      setExamTemplatePreview({
        template,
        questions,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.error(error);
      setExamTemplatePreview({
        template,
        questions: [],
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "No se pudieron extraer preguntas de la plantilla.",
      });
    }
  };

  const buildExamTemplateStoragePath = (kind: ExamTemplateKind, fileName: string) => {
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `exam-templates/${groupId}/${selectedCourseId}/${kind}-${Date.now()}-${safeFileName}`;
  };

  const uploadExamTemplateFile = async (
    kind: ExamTemplateKind,
    file: File,
  ): Promise<CourseExamTemplate> => {
    const validationError = validateExamTemplateFile(file);
    if (validationError) throw new Error(validationError);

    const storagePath = buildExamTemplateStoragePath(kind, file.name);
    const storageRef = ref(getStorage(), storagePath);
    const snapshot = await uploadBytes(storageRef, file, {
      contentType: file.type || (file.name.toLowerCase().endsWith(".docx")
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/msword"),
    });
    const downloadUrl = await getDownloadURL(snapshot.ref);
    let structuredTemplateId: string | null = null;
    if (kind === "extraordinary") {
      const questions = await parseGlobalExamQuestionsFromTemplateFile(file);
      if (questions.length === 0) {
        throw new Error("No se detectaron preguntas con respuesta correcta para activar el extraordinario.");
      }
      const structuredTemplate = await createGlobalExamTemplate({
        examKind: "extraordinary",
        title: `Examen extraordinario - ${selectedCourse?.courseName ?? "Materia"}`,
        description: "Examen extraordinario generado desde la plantilla de cierre de materia.",
        courseId: selectedCourseId,
        courseName: selectedCourse?.courseName ?? "Materia",
        groupId,
        status: "published",
        questions,
      });
      structuredTemplateId = structuredTemplate.id;
      setExistingExtraordinaryExamTemplatesByCourse((prev) => ({
        ...prev,
        [selectedCourseId]: structuredTemplate,
      }));
    }

    return {
      kind,
      fileName: file.name,
      fileSize: file.size,
      contentType: file.type || snapshot.metadata.contentType || "",
      storagePath,
      downloadUrl,
      uploadedAt: new Date(),
      uploadedById: currentUserId,
      uploadedByName: auth.currentUser?.displayName ?? auth.currentUser?.email ?? "Profesor",
      structuredTemplateId,
    };
  };

  const handleUploadExamTemplate = async (kind: ExamTemplateKind, file: File | null) => {
    if (!file || !selectedCourseId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cargar plantillas.");
      return;
    }
    setUploadingTemplateKind(kind);
    try {
      const template = await uploadExamTemplateFile(kind, file);
      await persistCourseExamTemplate(kind, template);
      void openExamTemplatePreview(template, file);
      toast.success(`${EXAM_TEMPLATE_KIND_LABELS[kind]} cargado correctamente.`);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "No se pudo cargar la plantilla.");
    } finally {
      setUploadingTemplateKind(null);
    }
  };

  const openExtraConceptModal = () => {
    if (!selectedCourseId) return;
    void fetchConceptSuggestions()
      .then((suggestions) => {
        setExtraConceptSuggestions(suggestions);
      })
      .catch((error) => {
        if (!isPermissionDeniedError(error)) {
          console.warn("No se pudieron refrescar sugerencias de conceptos extra:", error);
        }
      });
    const currentDrafts = getCourseExtraConceptDrafts();
    setExtraConceptModalDrafts(currentDrafts.map((entry) => ({ ...entry })));
    setExtraConceptModalError(null);
    setExtraConceptModalOpen(true);
  };

  const closeExtraConceptModal = () => {
    if (savingExtraConceptModal) return;
    setExtraConceptModalOpen(false);
    setExtraConceptModalError(null);
    setExtraConceptModalDrafts([]);
    setActiveExtraConceptDropdownId(null);
  };

  const addExtraConceptModalRow = () => {
    setExtraConceptModalDrafts((prev) => [
      ...prev,
      { id: createExtraConceptId(), concept: "", defaultPoints: "" },
    ]);
  };

  const updateExtraConceptModalDraft = (
    draftId: string,
    patch: Partial<Pick<ExtraConceptDraft, "concept" | "defaultPoints">>,
  ) => {
    setExtraConceptModalDrafts((prev) =>
      prev.map((entry) => (entry.id === draftId ? { ...entry, ...patch } : entry)),
    );
  };

  const removeExtraConceptModalDraft = (draftId: string) => {
    setExtraConceptModalDrafts((prev) => prev.filter((entry) => entry.id !== draftId));
    setActiveExtraConceptDropdownId((prev) => (prev === draftId ? null : prev));
  };

  const getFilteredSuggestionsForDraft = (draftId: string, inputValue: string): string[] => {
    const query = toConceptComparable(inputValue);
    const seen = new Set<string>();

    return extraConceptSuggestions
      .map((suggestion) => suggestion.trim())
      .filter((suggestion) => suggestion.length > 0)
      .filter((suggestion) => {
        const normalized = toConceptComparable(suggestion);
        if (!normalized) return false;
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        if (!query) return true;
        return normalized.includes(query);
      })
      .slice(0, 8);
  };

  const handleSaveExtraConceptModal = async () => {
    if (!selectedCourseId) return;
    const resolution = resolveCourseConceptsFromDrafts(extraConceptModalDrafts);
    if (resolution.errorMessage) {
      setExtraConceptModalError(resolution.errorMessage);
      return;
    }

    setSavingExtraConceptModal(true);
    try {
      await persistCourseExtraConcepts(resolution.concepts);
      await persistConceptSuggestions(resolution.concepts);
      setExtraConceptModalOpen(false);
      setExtraConceptModalError(null);
      setExtraConceptModalDrafts([]);
      setActiveExtraConceptDropdownId(null);
      toast.success("Conceptos extra actualizados para la materia seleccionada.");
    } catch (error) {
      console.error(error);
      setExtraConceptModalError("No se pudo guardar el concepto extra global.");
    } finally {
      setSavingExtraConceptModal(false);
    }
  };

  const upsertLocalClosure = (
    studentId: string,
    courseId: string,
    closure: CourseClosureState,
    enrollmentId: string,
  ) => {
    setEnrollmentByStudent((prev) => {
      const current = prev[studentId] ?? { id: enrollmentId, courseClosures: {} };
      return {
        ...prev,
        [studentId]: {
          ...current,
          id: enrollmentId,
          courseClosures: {
            ...current.courseClosures,
            [courseId]: closure,
          },
        },
      };
    });
  };

  const initializeSignatureCanvas = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  };

  const clearSignatureCanvas = () => {
    initializeSignatureCanvas();
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
    setHasSignatureStroke(false);
    setSignatureError(null);
  };

  const getCanvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const handleSignaturePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = signatureCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const point = getCanvasPoint(event);
    if (!canvas || !ctx || !point) return;
    drawingSignatureRef.current = true;
    signatureLastPointRef.current = point;
    canvas.setPointerCapture(event.pointerId);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    setHasSignatureStroke(true);
    setSignatureError(null);
  };

  const handleSignaturePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingSignatureRef.current) return;
    event.preventDefault();
    const ctx = signatureCanvasRef.current?.getContext("2d");
    const point = getCanvasPoint(event);
    const previous = signatureLastPointRef.current;
    if (!ctx || !point || !previous) return;
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    signatureLastPointRef.current = point;
    setHasSignatureStroke(true);
  };

  const handleSignaturePointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingSignatureRef.current) return;
    event.preventDefault();
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
  };

  const resolveSignatureModal = (value: SignatureResult | null) => {
    const resolver = signatureModalResolverRef.current;
    signatureModalResolverRef.current = null;
    setSignatureModalContext(null);
    setSignerNameInput("");
    setSignatureError(null);
    setHasSignatureStroke(false);
    drawingSignatureRef.current = false;
    signatureLastPointRef.current = null;
    resolver?.(value);
  };

  const requestDigitalSignature = (context: SignatureModalContext) =>
    new Promise<SignatureResult | null>((resolve) => {
      signatureModalResolverRef.current = resolve;
      setSignerNameInput("");
      setSignatureError(null);
      setHasSignatureStroke(false);
      drawingSignatureRef.current = false;
      signatureLastPointRef.current = null;
      setSignatureModalContext(context);
    });

  const resolveConfirmationModal = (accepted: boolean) => {
    const resolver = confirmationModalResolverRef.current;
    confirmationModalResolverRef.current = null;
    setConfirmationModalContext(null);
    resolver?.(accepted);
  };

  const requestConfirmation = (context: ConfirmationModalContext) =>
    new Promise<boolean>((resolve) => {
      confirmationModalResolverRef.current = resolve;
      setConfirmationModalContext(context);
    });

  const resolveExamTemplatesModal = (accepted: boolean) => {
    const resolver = examTemplatesModalResolverRef.current;
    examTemplatesModalResolverRef.current = null;
    setExamTemplatesModalOpen(false);
    resolver?.(accepted);
  };

  const requestRequiredExamTemplates = async () => {
    const resolvedProgram = selectedCourseSkipsExamTemplates
      ? selectedCourseProgram
      : await resolveSelectedCourseProgram();
    if (isExamOptionalProgram(resolvedProgram)) return true;

    if (
      selectedCourseId &&
      !Object.prototype.hasOwnProperty.call(existingGlobalExamTemplatesByCourse, selectedCourseId)
    ) {
      try {
        await fetchExistingGlobalExamTemplate();
      } catch (error) {
        console.warn("No se pudo verificar si ya existe examen global para la materia:", error);
      }
    }

    setExamTemplatesModalOpen(true);
    return new Promise<boolean>((resolve) => {
      examTemplatesModalResolverRef.current = resolve;
    });
  };

  const confirmDigitalSignature = () => {
    if (!signatureModalContext) return;
    const signerName = signerNameInput.trim();
    if (signerName.length < 3) {
      setSignatureError("Escribe tu nombre completo para firmar.");
      return;
    }
    if (!hasSignatureStroke) {
      setSignatureError("Agrega tu firma en el recuadro.");
      return;
    }
    const canvas = signatureCanvasRef.current;
    if (!canvas) {
      setSignatureError("No se pudo leer la firma, intenta nuevamente.");
      return;
    }
    resolveSignatureModal({
      signerName,
      signedAt: new Date(),
      signatureDataUrl: canvas.toDataURL("image/png"),
      context: signatureModalContext,
    });
  };

  const loadPdfBackgroundDataUrl = async (): Promise<string | null> => {
    if (pdfBackgroundDataUrlRef.current) return pdfBackgroundDataUrlRef.current;
    try {
      const response = await fetch("/bg-pdf-01.png", { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("No se pudo convertir el fondo del PDF"));
        };
        reader.onerror = () => reject(new Error("No se pudo leer el fondo del PDF"));
        reader.readAsDataURL(blob);
      });
      pdfBackgroundDataUrlRef.current = dataUrl;
      return dataUrl;
    } catch (error) {
      console.error("No se pudo cargar bg-pdf-01.png para el PDF:", error);
      return null;
    }
  };

  const loadPdfLogoDataUrl = async (): Promise<string | null> => {
    if (pdfLogoDataUrlRef.current) return pdfLogoDataUrlRef.current;
    try {
      const response = await fetch("/university-logo.jpg", { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("No se pudo convertir el logo del PDF"));
        };
        reader.onerror = () => reject(new Error("No se pudo leer el logo del PDF"));
        reader.readAsDataURL(blob);
      });
      pdfLogoDataUrlRef.current = dataUrl;
      return dataUrl;
    } catch (error) {
      console.error("No se pudo cargar university-logo.jpg para el PDF:", error);
      return null;
    }
  };

  const downloadSignedClosurePdf = async (signature: SignatureResult) => {
    const pdf = new jsPDF({ unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const contentWidth = Math.min(460, pageWidth - 120);
    const marginX = (pageWidth - contentWidth) / 2;
    const bottomLimit = pageHeight - 132;
    const topStart = 130;
    let y = topStart;
    const bgImage = await loadPdfBackgroundDataUrl();

    const rows = signature.context.rows;
    const avgFinalGrade =
      rows.length > 0
        ? rows.reduce((acc, row) => acc + row.finalGrade, 0) / rows.length
        : 0;
    const columns = {
      student: marginX + 2,
      auto: marginX + 300,
      final: marginX + 348,
      pending: marginX + 406,
    };

    const drawPageBackground = () => {
      if (bgImage) {
        pdf.addImage(bgImage, "PNG", 0, 0, pageWidth, pageHeight);
      }
    };

    const drawTopHeader = () => {
      pdf.setTextColor(124, 21, 45);
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(22);
      pdf.text("Acta de Cierre de Calificaciones", pageWidth / 2, y, { align: "center" });
      y += 14;
      pdf.setDrawColor(124, 21, 45);
      pdf.setLineWidth(1);
      pdf.line(marginX, y, marginX + contentWidth, y);
      pdf.setTextColor(15, 23, 42);
      y += 20;
    };

    const drawMetaSection = () => {
      const metaRows = [
        { label: "Materia:", value: signature.context.courseName },
        { label: "Docente firmante:", value: signature.signerName },
        { label: "Fecha y hora de firma:", value: formatDateTime(signature.signedAt) },
        { label: "Grupo academico:", value: "asignado en plataforma" },
      ];
      const labelWidth = 184;
      const valueX = marginX + labelWidth;
      const valueWidth = contentWidth - labelWidth - 4;

      pdf.setFontSize(12);
      metaRows.forEach((item) => {
        const valueLines = pdf.splitTextToSize(item.value, valueWidth) as string[];
        const rowHeight = Math.max(16, valueLines.length * 14);
        pdf.setFont("helvetica", "bold");
        pdf.text(item.label, marginX, y);
        pdf.setFont("helvetica", "normal");
        pdf.text(valueLines, valueX, y);
        y += rowHeight + 4;
      });

      y += 4;
    };

    const drawSummaryRow = () => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(12);
      pdf.text(`Alumnos incluidos: ${rows.length}`, marginX, y);
      pdf.text(`Promedio final: ${avgFinalGrade.toFixed(1)}`, marginX + contentWidth, y, { align: "right" });
      y += 14;
      pdf.setDrawColor(203, 213, 225);
      pdf.setLineWidth(0.8);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 16;
    };

    const drawTableHeader = () => {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11);
      pdf.text("Alumno", columns.student, y);
      pdf.text("Auto", columns.auto, y);
      pdf.text("Final", columns.final, y);
      pdf.text("Pendientes", columns.pending, y);
      y += 8;
      pdf.setDrawColor(148, 163, 184);
      pdf.setLineWidth(0.9);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 16;
    };

    const startNewPage = (withTableHeader = false) => {
      pdf.addPage();
      drawPageBackground();
      y = topStart;
      drawTopHeader();
      if (withTableHeader) {
        drawTableHeader();
      }
    };

    const ensureSpace = (required: number, withTableHeader = false) => {
      if (y + required <= bottomLimit) return;
      startNewPage(withTableHeader);
    };

    drawPageBackground();
    drawTopHeader();
    drawMetaSection();
    drawSummaryRow();
    drawTableHeader();

    rows.forEach((row, index) => {
      const studentName = `${index + 1}. ${row.studentName || "Alumno sin nombre"}`;
      const nameLines = pdf.splitTextToSize(studentName, 270) as string[];
      const rowHeight = Math.max(24, nameLines.length * 12 + 6);
      ensureSpace(rowHeight + 12, true);

      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(11);
      pdf.text(nameLines, columns.student, y);
      pdf.text(typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—", columns.auto, y);
      pdf.text(row.finalGrade.toFixed(1), columns.final, y);
      pdf.text(`${row.pendingUngradedCount}/${row.totalEvaluable}`, columns.pending, y);

      y += rowHeight;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.7);
      pdf.line(marginX, y, marginX + contentWidth, y);
      y += 10;
    });

    ensureSpace(210, false);

    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    pdf.text("Firma digital del docente", marginX, y);

    y += 12;
    pdf.setDrawColor(148, 163, 184);
    pdf.setLineWidth(0.9);
    pdf.line(marginX, y, marginX + contentWidth, y);

    const signatureBlockTop = y + 18;
    const signatureLineWidth = 280;
    const signatureLineY = signatureBlockTop + 64;

    pdf.setDrawColor(120, 120, 120);
    pdf.setLineWidth(0.85);
    pdf.line(marginX, signatureLineY, marginX + signatureLineWidth, signatureLineY);

    pdf.addImage(
      signature.signatureDataUrl,
      "PNG",
      marginX + 14,
      signatureLineY - 58,
      signatureLineWidth - 28,
      56,
    );

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(71, 85, 105);
    pdf.text("Firma del docente", marginX, signatureLineY + 14);

    const legalX = marginX + signatureLineWidth + 18;
    const legalWidth = contentWidth - signatureLineWidth - 18;
    const legalLineHeight = 14;
    pdf.setFontSize(12);
    pdf.setTextColor(15, 23, 42);
    const legalText = pdf.splitTextToSize(
      "Con esta firma se valida el cierre de calificaciones mostrado en este documento.",
      legalWidth,
    ) as string[];
    pdf.text(legalText, legalX, signatureBlockTop + 12);
    const legalBottomY = signatureBlockTop + 12 + Math.max(0, (legalText.length - 1) * legalLineHeight);
    const registeredLabelY = legalBottomY + 24;
    pdf.text("Fecha de registro:", legalX, registeredLabelY);
    pdf.setFont("helvetica", "bold");
    const registeredValueY = registeredLabelY + 16;
    pdf.text(formatDateTime(signature.signedAt), legalX, registeredValueY);

    const signerNameY = signatureLineY + 38;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(15);
    pdf.text(signature.signerName, marginX, signerNameY);

    y = Math.max(signerNameY + 18, registeredValueY + 18);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(11);
    pdf.setTextColor(71, 85, 105);
    pdf.text("Documento generado por Plataforma UDEL.", marginX, y);

    const safeCourseName = signature.context.courseName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    const stamp = signature.signedAt
      .toISOString()
      .slice(0, 16)
      .replace("T", "-")
      .replace(":", "");
    const fileName = `acta-cierre-${safeCourseName || "materia"}-${stamp}.pdf`;
    pdf.save(fileName);
  };

  useEffect(() => {
    if (!signatureModalContext) return;
    const timer = window.setTimeout(() => {
      initializeSignatureCanvas();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [signatureModalContext]);

  useEffect(() => {
    return () => {
      signatureModalResolverRef.current?.(null);
      signatureModalResolverRef.current = null;
      confirmationModalResolverRef.current?.(false);
      confirmationModalResolverRef.current = null;
      examTemplatesModalResolverRef.current?.(false);
      examTemplatesModalResolverRef.current = null;
    };
  }, []);

  const handleCloseCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (processingNotifyStudentId === row.studentId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }
    const finalResolution = resolveFinalGradeForRow(row);
    if (finalResolution.errorMessage || finalResolution.finalGrade === null) {
      toast.error(finalResolution.errorMessage ?? "No se pudo calcular la calificación final.");
      return;
    }
    const { finalGrade, campusGrades, manualOverride, extraConcepts, extraPointsTotal } = finalResolution;

    const templatesReady = await requestRequiredExamTemplates();
    if (!templatesReady) return;

    if (row.pendingUngradedCount > 0) {
      const confirmed = await requestConfirmation({
        title: "Actividades pendientes",
        message:
          `Este alumno tiene ${row.pendingUngradedCount} actividades sin calificar. ` +
          "¿Deseas cerrar de todas formas?",
        confirmLabel: "Cerrar de todas formas",
        cancelLabel: "Cancelar",
        tone: "warning",
      });
      if (!confirmed) return;
    }

    const selectedCourseName = selectedCourse?.courseName ?? "Materia";
    const signature = await requestDigitalSignature({
      scope: "single",
      courseId: selectedCourseId,
      courseName: selectedCourseName,
      requestedAt: new Date(),
      rows: [
        {
          studentId: row.studentId,
          studentName: row.studentName,
          autoGrade: row.autoGrade,
          finalGrade,
          pendingUngradedCount: row.pendingUngradedCount,
          totalEvaluable: row.totalEvaluable,
        },
      ],
    });
    if (!signature) return;

    setProcessingStudentId(row.studentId);
    try {
      const previousClosure = row.closure ?? null;
      const closurePayload: CourseClosureState = {
        status: "closed",
        courseName: selectedCourseName,
        finalGrade,
        autoGrade: row.autoGrade,
        campusTasksGrade: campusGrades.campusTasksGrade,
        campusFinalExamGrade: campusGrades.campusFinalExamGrade,
        globalExamGrade: campusGrades.globalExamGrade,
        extraordinaryExamGrade: campusGrades.extraordinaryExamGrade,
        extraConcepts,
        extraPointsTotal,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        closedByType: "teacher",
        closureTrigger: "manual",
        lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
        closedAt: new Date(),
        closedById: currentUserId,
        closedByName: signature.signerName,
        updatedAt: new Date(),
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: closurePayload.status,
              courseName: selectedCourseName,
              finalGrade: closurePayload.finalGrade,
              autoGrade: closurePayload.autoGrade,
              campusTasksGrade: closurePayload.campusTasksGrade,
              campusFinalExamGrade: closurePayload.campusFinalExamGrade,
              globalExamGrade: closurePayload.globalExamGrade,
              extraordinaryExamGrade: closurePayload.extraordinaryExamGrade,
              extraConcepts: closurePayload.extraConcepts ?? [],
              extraPointsTotal: closurePayload.extraPointsTotal ?? 0,
              manualOverride: closurePayload.manualOverride,
              pendingUngradedCount: closurePayload.pendingUngradedCount,
              closedByType: closurePayload.closedByType,
              closureTrigger: closurePayload.closureTrigger,
              lastFinalGradeNotifiedAt: closurePayload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: closurePayload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: closurePayload.lastFinalGradeNotifiedValue ?? null,
              closedAt: closurePayload.closedAt,
              closedById: closurePayload.closedById,
              closedByName: closurePayload.closedByName,
              updatedAt: closurePayload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, closurePayload, row.enrollmentId);
      await persistConceptSuggestions(extraConcepts);
      const autoExtraordinaryExamSummary = await ensureExtraordinaryExamAssignmentsForStudents([{ row, finalGrade }]);
      await downloadSignedClosurePdf(signature);
      showAutoExtraordinaryExamAssignmentNotice(autoExtraordinaryExamSummary);
      toast.success(`Materia cerrada para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo cerrar la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleSaveFinalGradeForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (processingNotifyStudentId === row.studentId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para guardar calificaciones.");
      return;
    }

    const finalResolution = resolveFinalGradeForRow(row);
    if (finalResolution.errorMessage || finalResolution.finalGrade === null) {
      toast.error(finalResolution.errorMessage ?? "No se pudo calcular la calificación final.");
      return;
    }
    const { finalGrade, campusGrades, manualOverride, extraConcepts, extraPointsTotal } = finalResolution;
    const selectedCourseName = selectedCourse?.courseName ?? "Materia";

    setProcessingStudentId(row.studentId);
    try {
      const now = new Date();
      const previousClosure = row.closure ?? null;
      const isClosed = previousClosure?.status === "closed";
      const payload: CourseClosureState = {
        status: isClosed ? "closed" : "open",
        courseName: selectedCourseName,
        finalGrade,
        autoGrade: row.autoGrade,
        campusTasksGrade: campusGrades.campusTasksGrade,
        campusFinalExamGrade: campusGrades.campusFinalExamGrade,
        globalExamGrade: campusGrades.globalExamGrade,
        extraordinaryExamGrade: campusGrades.extraordinaryExamGrade,
        extraConcepts,
        extraPointsTotal,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        closedByType: previousClosure?.closedByType,
        closureTrigger: previousClosure?.closureTrigger,
        lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
        closedAt: previousClosure?.closedAt ?? null,
        closedById: previousClosure?.closedById,
        closedByName: previousClosure?.closedByName,
        reopenedAt: previousClosure?.reopenedAt ?? null,
        reopenedById: previousClosure?.reopenedById,
        reopenedByName: previousClosure?.reopenedByName,
        updatedAt: now,
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: payload.status,
              courseName: selectedCourseName,
              finalGrade: payload.finalGrade,
              autoGrade: payload.autoGrade,
              campusTasksGrade: payload.campusTasksGrade,
              campusFinalExamGrade: payload.campusFinalExamGrade,
              globalExamGrade: payload.globalExamGrade,
              extraordinaryExamGrade: payload.extraordinaryExamGrade,
              extraConcepts: payload.extraConcepts ?? [],
              extraPointsTotal: payload.extraPointsTotal ?? 0,
              manualOverride: payload.manualOverride,
              pendingUngradedCount: payload.pendingUngradedCount,
              closedByType: payload.closedByType ?? null,
              closureTrigger: payload.closureTrigger ?? null,
              lastFinalGradeNotifiedAt: payload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: payload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: payload.lastFinalGradeNotifiedValue ?? null,
              closedAt: payload.closedAt ?? null,
              closedById: payload.closedById ?? null,
              closedByName: payload.closedByName ?? null,
              reopenedAt: payload.reopenedAt ?? null,
              reopenedById: payload.reopenedById ?? null,
              reopenedByName: payload.reopenedByName ?? null,
              updatedAt: payload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, payload, row.enrollmentId);
      const key = getDraftKey(row.studentId);
      setDraftCampusTasksGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.campusTasksGrade),
      }));
      setDraftCampusFinalExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.campusFinalExamGrade),
      }));
      setDraftGlobalExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.globalExamGrade),
      }));
      setDraftExtraordinaryExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.extraordinaryExamGrade),
      }));
      setDraftExtraPointsByStudent((prev) => ({
        ...prev,
        [key]: Object.fromEntries(
          extraConcepts.map((concept) => [
            concept.id,
            concept.points > 0 ? formatGradeInput(concept.points) : "",
          ]),
        ),
      }));
      setDraftFinalGrades((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });

      await persistConceptSuggestions(extraConcepts);
      toast.success(`Calificación guardada para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo guardar la calificación final.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleSaveAndNotifyFinalGradeForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para calificar materias.");
      return;
    }

    const finalResolution = resolveFinalGradeForRow(row);
    if (finalResolution.errorMessage || finalResolution.finalGrade === null) {
      toast.error(finalResolution.errorMessage ?? "No se pudo calcular la calificación final.");
      return;
    }
    const { finalGrade, campusGrades, manualOverride, extraConcepts, extraPointsTotal } = finalResolution;
    const selectedCourseName = selectedCourse?.courseName ?? "Materia";

    setProcessingNotifyStudentId(row.studentId);
    let gradeSaved = false;
    try {
      const now = new Date();
      const previousClosure = row.closure ?? null;
      const isClosed = previousClosure?.status === "closed";
      const payload: CourseClosureState = {
        status: isClosed ? "closed" : "open",
        courseName: selectedCourseName,
        finalGrade,
        autoGrade: row.autoGrade,
        campusTasksGrade: campusGrades.campusTasksGrade,
        campusFinalExamGrade: campusGrades.campusFinalExamGrade,
        globalExamGrade: campusGrades.globalExamGrade,
        extraordinaryExamGrade: campusGrades.extraordinaryExamGrade,
        extraConcepts,
        extraPointsTotal,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        closedByType: previousClosure?.closedByType,
        closureTrigger: previousClosure?.closureTrigger,
        lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
        closedAt: previousClosure?.closedAt ?? null,
        closedById: previousClosure?.closedById,
        closedByName: previousClosure?.closedByName,
        reopenedAt: previousClosure?.reopenedAt ?? null,
        reopenedById: previousClosure?.reopenedById,
        reopenedByName: previousClosure?.reopenedByName,
        updatedAt: now,
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: payload.status,
              courseName: selectedCourseName,
              finalGrade: payload.finalGrade,
              autoGrade: payload.autoGrade,
              campusTasksGrade: payload.campusTasksGrade,
              campusFinalExamGrade: payload.campusFinalExamGrade,
              globalExamGrade: payload.globalExamGrade,
              extraordinaryExamGrade: payload.extraordinaryExamGrade,
              extraConcepts: payload.extraConcepts ?? [],
              extraPointsTotal: payload.extraPointsTotal ?? 0,
              manualOverride: payload.manualOverride,
              pendingUngradedCount: payload.pendingUngradedCount,
              closedByType: payload.closedByType ?? null,
              closureTrigger: payload.closureTrigger ?? null,
              lastFinalGradeNotifiedAt: payload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: payload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: payload.lastFinalGradeNotifiedValue ?? null,
              closedAt: payload.closedAt ?? null,
              closedById: payload.closedById ?? null,
              closedByName: payload.closedByName ?? null,
              reopenedAt: payload.reopenedAt ?? null,
              reopenedById: payload.reopenedById ?? null,
              reopenedByName: payload.reopenedByName ?? null,
              updatedAt: payload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      gradeSaved = true;
      upsertLocalClosure(row.studentId, selectedCourseId, payload, row.enrollmentId);
      const key = getDraftKey(row.studentId);
      setDraftCampusTasksGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.campusTasksGrade),
      }));
      setDraftCampusFinalExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.campusFinalExamGrade),
      }));
      setDraftGlobalExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.globalExamGrade),
      }));
      setDraftExtraordinaryExamGrades((prev) => ({
        ...prev,
        [key]: formatGradeInput(campusGrades.extraordinaryExamGrade),
      }));
      setDraftExtraPointsByStudent((prev) => ({
        ...prev,
        [key]: Object.fromEntries(
          extraConcepts.map((concept) => [
            concept.id,
            concept.points > 0 ? formatGradeInput(concept.points) : "",
          ]),
        ),
      }));
      setDraftFinalGrades((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await persistConceptSuggestions(extraConcepts);

      const currentSessionUser = auth.currentUser;
      if (!currentSessionUser) {
        throw new Error("Tu sesión expiró. Inicia sesión nuevamente.");
      }
      const token = await currentSessionUser.getIdToken();
      const response = await fetch("/api/notifications/whatsapp/final-grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groupId,
          studentId: row.studentId,
          courseId: selectedCourseId,
          finalGrade,
        }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { notified?: boolean; reason?: string };
      };

      if (!response.ok || data.success !== true) {
        throw new Error(data.error || "No se pudo notificar por WhatsApp");
      }

      if (data.data?.notified === false) {
        toast(
          `Calificación guardada para ${row.studentName}, pero WhatsApp no enviado: ${
            data.data.reason || "sin detalle"
          }`,
        );
      } else {
        const notifiedAt = new Date();
        const notifiedPayload: CourseClosureState = {
          ...payload,
          courseName: selectedCourseName,
          lastFinalGradeNotifiedAt: notifiedAt,
          lastFinalGradeNotifiedBy: currentUserId,
          lastFinalGradeNotifiedValue: finalGrade,
          updatedAt: notifiedAt,
        };

        await setDoc(
          enrollmentRef,
          {
            studentId: row.studentId,
            studentName: row.studentName,
            groupId,
              courseClosures: {
                [selectedCourseId]: {
                  status: notifiedPayload.status,
                  courseName: selectedCourseName,
                  finalGrade: notifiedPayload.finalGrade,
                autoGrade: notifiedPayload.autoGrade,
                campusTasksGrade: notifiedPayload.campusTasksGrade,
                campusFinalExamGrade: notifiedPayload.campusFinalExamGrade,
                globalExamGrade: notifiedPayload.globalExamGrade,
                extraordinaryExamGrade: notifiedPayload.extraordinaryExamGrade,
                extraConcepts: notifiedPayload.extraConcepts ?? [],
                extraPointsTotal: notifiedPayload.extraPointsTotal ?? 0,
                manualOverride: notifiedPayload.manualOverride,
                pendingUngradedCount: notifiedPayload.pendingUngradedCount,
                closedByType: notifiedPayload.closedByType ?? null,
                closureTrigger: notifiedPayload.closureTrigger ?? null,
                lastFinalGradeNotifiedAt: notifiedPayload.lastFinalGradeNotifiedAt,
                lastFinalGradeNotifiedBy: notifiedPayload.lastFinalGradeNotifiedBy,
                lastFinalGradeNotifiedValue: notifiedPayload.lastFinalGradeNotifiedValue,
                closedAt: notifiedPayload.closedAt ?? null,
                closedById: notifiedPayload.closedById ?? null,
                closedByName: notifiedPayload.closedByName ?? null,
                reopenedAt: notifiedPayload.reopenedAt ?? null,
                reopenedById: notifiedPayload.reopenedById ?? null,
                reopenedByName: notifiedPayload.reopenedByName ?? null,
                updatedAt: notifiedPayload.updatedAt,
              },
            },
          },
          { merge: true },
        );

        upsertLocalClosure(row.studentId, selectedCourseId, notifiedPayload, row.enrollmentId);
        toast.success(`Calificación guardada y notificada a ${row.studentName}`);
      }
    } catch (err) {
      console.error(err);
      const message =
        err instanceof Error ? err.message : "Error al guardar/notificar calificación";
      if (gradeSaved) {
        toast.error(`Calificación guardada, pero no se pudo notificar por WhatsApp: ${message}`);
      } else {
        toast.error(message);
      }
    } finally {
      setProcessingNotifyStudentId(null);
    }
  };

  const handleReopenCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (processingNotifyStudentId === row.studentId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para reabrir materias.");
      return;
    }

    const confirmed = await requestConfirmation({
      title: "Reabrir materia",
      message: `¿Reabrir la materia para ${row.studentName}?`,
      confirmLabel: "Sí, reabrir",
      cancelLabel: "Cancelar",
      tone: "default",
    });
    if (!confirmed) return;

    setProcessingStudentId(row.studentId);
    try {
      const selectedCourseName = selectedCourse?.courseName ?? "Materia";
      const previous = row.closure ?? null;
      const reopenPayload: CourseClosureState = {
        status: "open",
        courseName: selectedCourseName,
        finalGrade: previous?.finalGrade,
        autoGrade: previous?.autoGrade ?? row.autoGrade,
        campusTasksGrade: previous?.campusTasksGrade ?? null,
        campusFinalExamGrade: previous?.campusFinalExamGrade ?? null,
        globalExamGrade: previous?.globalExamGrade ?? null,
        extraordinaryExamGrade: previous?.extraordinaryExamGrade ?? null,
        extraConcepts: previous?.extraConcepts ?? [],
        extraPointsTotal: previous?.extraPointsTotal ?? 0,
        manualOverride: previous?.manualOverride ?? false,
        pendingUngradedCount: row.pendingUngradedCount,
        closedByType: previous?.closedByType,
        closureTrigger: previous?.closureTrigger,
        lastFinalGradeNotifiedAt: previous?.lastFinalGradeNotifiedAt ?? null,
        lastFinalGradeNotifiedBy: previous?.lastFinalGradeNotifiedBy,
        lastFinalGradeNotifiedValue: previous?.lastFinalGradeNotifiedValue,
        closedAt: previous?.closedAt ?? null,
        closedById: previous?.closedById,
        closedByName: previous?.closedByName,
        reopenedAt: new Date(),
        reopenedById: currentUserId,
        reopenedByName: "Profesor",
        updatedAt: new Date(),
      };

      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          courseClosures: {
            [selectedCourseId]: {
              status: reopenPayload.status,
              courseName: selectedCourseName,
              finalGrade: reopenPayload.finalGrade ?? null,
              autoGrade: reopenPayload.autoGrade ?? null,
              campusTasksGrade: reopenPayload.campusTasksGrade ?? null,
              campusFinalExamGrade: reopenPayload.campusFinalExamGrade ?? null,
              globalExamGrade: reopenPayload.globalExamGrade ?? null,
              extraordinaryExamGrade: reopenPayload.extraordinaryExamGrade ?? null,
              extraConcepts: reopenPayload.extraConcepts ?? [],
              extraPointsTotal: reopenPayload.extraPointsTotal ?? 0,
              manualOverride: reopenPayload.manualOverride ?? false,
              pendingUngradedCount: reopenPayload.pendingUngradedCount,
              closedByType: reopenPayload.closedByType ?? null,
              closureTrigger: reopenPayload.closureTrigger ?? null,
              lastFinalGradeNotifiedAt: reopenPayload.lastFinalGradeNotifiedAt ?? null,
              lastFinalGradeNotifiedBy: reopenPayload.lastFinalGradeNotifiedBy ?? null,
              lastFinalGradeNotifiedValue: reopenPayload.lastFinalGradeNotifiedValue ?? null,
              closedAt: reopenPayload.closedAt ?? null,
              closedById: reopenPayload.closedById ?? null,
              closedByName: reopenPayload.closedByName ?? null,
              reopenedAt: reopenPayload.reopenedAt,
              reopenedById: reopenPayload.reopenedById,
              reopenedByName: reopenPayload.reopenedByName,
              updatedAt: reopenPayload.updatedAt,
            },
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, reopenPayload, row.enrollmentId);
      toast.success(`Materia reabierta para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo reabrir la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleCloseCourseForAll = async () => {
    if (!selectedCourseId) return;
    if (processingNotifyStudentId !== null) {
      toast("Espera a que termine la notificación en curso.");
      return;
    }
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }
    const openRows = rows.filter((row) => row.closure?.status !== "closed");
    if (!openRows.length) {
      toast("Todas las materias de esta selección ya están cerradas.");
      return;
    }

    const parsedRows = openRows.map((row) => {
      const resolution = resolveFinalGradeForRow(row);
      return {
        row,
        finalGrade: resolution.finalGrade,
        manualOverride: resolution.manualOverride,
        campusGrades: resolution.campusGrades,
        extraConcepts: resolution.extraConcepts,
        extraPointsTotal: resolution.extraPointsTotal,
        errorMessage: resolution.errorMessage,
      };
    });

    const invalidRows = parsedRows.filter(
      ({ finalGrade, errorMessage }) =>
        typeof finalGrade !== "number" || !Number.isFinite(finalGrade) || Boolean(errorMessage),
    );
    if (invalidRows.length > 0) {
      toast.error(
        `No se pudo calcular un Final válido (0..100) para ${invalidRows.length} alumno(s).`,
      );
      return;
    }

    const templatesReady = await requestRequiredExamTemplates();
    if (!templatesReady) return;

    const pendingStudents = openRows.filter((row) => row.pendingUngradedCount > 0);
    const pendingTotal = pendingStudents.reduce((acc, row) => acc + row.pendingUngradedCount, 0);
    if (pendingStudents.length > 0) {
      const confirmed = await requestConfirmation({
        title: "Hay actividades pendientes",
        message:
          `Hay ${pendingStudents.length} alumno(s) con actividades pendientes ` +
          `(${pendingTotal} en total). ¿Cerrar de todas formas para todos?`,
        confirmLabel: "Cerrar de todas formas",
        cancelLabel: "Cancelar",
        tone: "warning",
      });
      if (!confirmed) return;
    }

    const selectedCourseName = selectedCourse?.courseName ?? "esta materia";
    const confirmedAll = await requestConfirmation({
      title: "Cerrar calificaciones de la materia",
      message:
        `Vas a cerrar calificaciones de "${selectedCourseName}" para ${openRows.length} alumno(s). ` +
        "Al confirmar, la materia se marcará como completada y se retirará de tu carga docente en este grupo.",
      confirmLabel: "Sí, cerrar calificaciones",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!confirmedAll) return;

    const signature = await requestDigitalSignature({
      scope: "all",
      courseId: selectedCourseId,
      courseName: selectedCourseName,
      requestedAt: new Date(),
      rows: parsedRows.map(({ row, finalGrade }) => ({
        studentId: row.studentId,
        studentName: row.studentName,
        autoGrade: row.autoGrade,
        finalGrade: finalGrade as number,
        pendingUngradedCount: row.pendingUngradedCount,
        totalEvaluable: row.totalEvaluable,
      })),
    });
    if (!signature) return;

    setProcessingAll(true);
    let processStage: "closing" | "unlinking" | "pdf" = "closing";
    try {
      const now = new Date();
      const chunkSize = 400;

      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(({ row, finalGrade, campusGrades, manualOverride, extraConcepts, extraPointsTotal }) => {
          if (typeof finalGrade !== "number") return;
          const previousClosure = row.closure ?? null;
          const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
          batch.set(
            enrollmentRef,
            {
              studentId: row.studentId,
              studentName: row.studentName,
              groupId,
              courseClosures: {
                [selectedCourseId]: {
                  status: "closed",
                  courseName: selectedCourseName,
                  finalGrade,
                  autoGrade: row.autoGrade,
                  campusTasksGrade: campusGrades.campusTasksGrade,
                  campusFinalExamGrade: campusGrades.campusFinalExamGrade,
                  globalExamGrade: campusGrades.globalExamGrade,
                  extraordinaryExamGrade: campusGrades.extraordinaryExamGrade,
                  extraConcepts,
                  extraPointsTotal,
                  manualOverride,
                  pendingUngradedCount: row.pendingUngradedCount,
                  closedByType: "teacher",
                  closureTrigger: "manual",
                  lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
                  lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy ?? null,
                  lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue ?? null,
                  closedAt: now,
                  closedById: currentUserId,
                  closedByName: signature.signerName,
                  updatedAt: now,
                },
              },
            },
            { merge: true },
          );
        });
        await batch.commit();
      }

      setEnrollmentByStudent((prev) => {
        const next = { ...prev };
        parsedRows.forEach(({ row, finalGrade, campusGrades, manualOverride, extraConcepts, extraPointsTotal }) => {
          if (typeof finalGrade !== "number") return;
          const previousClosure = row.closure ?? null;
          const current = next[row.studentId] ?? { id: row.enrollmentId, courseClosures: {} };
          next[row.studentId] = {
            ...current,
            id: row.enrollmentId,
            courseClosures: {
              ...current.courseClosures,
              [selectedCourseId]: {
                status: "closed",
                courseName: selectedCourseName,
                finalGrade,
                autoGrade: row.autoGrade,
                campusTasksGrade: campusGrades.campusTasksGrade,
                campusFinalExamGrade: campusGrades.campusFinalExamGrade,
                globalExamGrade: campusGrades.globalExamGrade,
                extraordinaryExamGrade: campusGrades.extraordinaryExamGrade,
                extraConcepts,
                extraPointsTotal,
                manualOverride,
                pendingUngradedCount: row.pendingUngradedCount,
                closedByType: "teacher",
                closureTrigger: "manual",
                lastFinalGradeNotifiedAt: previousClosure?.lastFinalGradeNotifiedAt ?? null,
                lastFinalGradeNotifiedBy: previousClosure?.lastFinalGradeNotifiedBy,
                lastFinalGradeNotifiedValue: previousClosure?.lastFinalGradeNotifiedValue,
                closedAt: now,
                closedById: currentUserId,
                closedByName: signature.signerName,
                updatedAt: now,
              },
            },
          };
        });
        return next;
      });
      const allConcepts = parsedRows.flatMap(({ extraConcepts }) => extraConcepts ?? []);
      await persistConceptSuggestions(allConcepts);
      const autoExtraordinaryExamSummary = await ensureExtraordinaryExamAssignmentsForStudents(
        parsedRows
          .filter(({ finalGrade }) => typeof finalGrade === "number")
          .map(({ row, finalGrade }) => ({ row, finalGrade: finalGrade as number })),
      );
      showAutoExtraordinaryExamAssignmentNotice(autoExtraordinaryExamSummary);

      processStage = "unlinking";
      const currentSessionUser = auth.currentUser;
      if (!currentSessionUser) {
        throw new Error("Tu sesión expiró. Inicia sesión nuevamente.");
      }
      const token = await currentSessionUser.getIdToken();
      const response = await fetch("/api/groups/unlink-course", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groupId,
          courseId: selectedCourseId,
          teacherId: currentUserId,
          scope: "teacher",
        }),
      });

      let data: { updated?: boolean; error?: string; message?: string } | null = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (!response.ok) {
        throw new Error(data?.error || "No se pudo desvincular la materia del grupo");
      }

      const unlinked = Boolean(data?.updated);
      if (unlinked) {
        await onCourseCompletedAndUnlinked?.(selectedCourseId);
      }

      processStage = "pdf";
      await downloadSignedClosurePdf(signature);

      if (unlinked) {
        toast.success(`Materia cerrada para ${openRows.length} alumno(s) y retirada de tu carga docente.`);
      } else {
        if (data?.message) {
          toast(data.message);
        }
        toast.success(`Materia cerrada para ${openRows.length} alumno(s).`);
      }
    } catch (err) {
      console.error(err);
      const message = err instanceof Error ? err.message : "Error inesperado al procesar el cierre";
      if (processStage === "closing") {
        toast.error("No se pudo cerrar la materia para todos.");
      } else if (processStage === "unlinking") {
        toast.error(`Calificaciones cerradas, pero hubo un error al desvincular: ${message}. No se generó el PDF.`);
      } else {
        toast.error(`Calificaciones cerradas y desvinculadas, pero no se pudo generar el PDF: ${message}`);
      }
    } finally {
      setProcessingAll(false);
    }
  };

  const courseExtraConceptsResolution = resolveExtraConceptsForCourse();
  const courseExtraConceptColumns = courseExtraConceptsResolution.concepts;

  const downloadGradesSummaryPdf = useCallback(async () => {
    if (!selectedCourseId || !selectedCourse) {
      toast.error("Selecciona una materia para descargar el PDF.");
      return;
    }
    if (rows.length === 0) {
      toast.error("No hay alumnos para exportar.");
      return;
    }

    setExportingGradesPdf(true);
    try {
      const pdf = new jsPDF({ unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 42;
      const contentWidth = pageWidth - marginX * 2;
      const topMargin = 42;
      const footerHeight = 34;
      const tableTop = 142;
      const tableBottom = pageHeight - footerHeight - 18;
      const rowHeight = 30;
      const columns = {
        index: { x: marginX, width: 28 },
        student: { x: marginX + 30, width: 220 },
        auto: { x: marginX + 263, width: 46 },
        final: { x: marginX + 316, width: 46 },
        pending: { x: marginX + 372, width: 58 },
        status: { x: marginX + 440, width: 68 },
      };
      const generatedAt = new Date();
      const generatedAtLabel = formatDateTime(generatedAt);
      const logoDataUrl = await loadPdfLogoDataUrl();
      const avgFinalGradeRows = rows
        .map((row) => row.closure?.finalGrade)
        .filter((grade): grade is number => typeof grade === "number" && Number.isFinite(grade));
      const avgFinalGrade =
        avgFinalGradeRows.length > 0
          ? avgFinalGradeRows.reduce((acc, grade) => acc + grade, 0) / avgFinalGradeRows.length
          : null;
      let pageNumber = 1;
      let y = tableTop;

      const drawHeader = () => {
        pdf.setFillColor(93, 17, 21);
        pdf.rect(0, 0, pageWidth, 98, "F");
        const titleX = logoDataUrl ? marginX + 58 : marginX;
        if (logoDataUrl) {
          pdf.addImage(logoDataUrl, "JPEG", marginX, 24, 44, 44);
        }
        pdf.setTextColor(255, 255, 255);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(19);
        pdf.text("Resumen de calificaciones", titleX, topMargin);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(10);
        const courseLines = pdf.splitTextToSize(selectedCourse.courseName, contentWidth - 178) as string[];
        pdf.text(courseLines.slice(0, 2), titleX, topMargin + 20);
        pdf.text(generatedAtLabel, pageWidth - marginX, topMargin, { align: "right" });

        pdf.setTextColor(15, 23, 42);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(10);
        pdf.text(`Alumnos: ${rows.length}`, marginX, 120);
        pdf.text(
          `Promedio final: ${avgFinalGrade === null ? "N/D" : avgFinalGrade.toFixed(1)}`,
          marginX + 96,
          120,
        );

        pdf.setFillColor(248, 250, 252);
        pdf.roundedRect(marginX, tableTop - 18, contentWidth, 24, 6, 6, "F");
        pdf.setTextColor(71, 85, 105);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(9);
        pdf.text("#", columns.index.x + 2, tableTop - 3);
        pdf.text("Alumno", columns.student.x, tableTop - 3);
        pdf.text("Auto", columns.auto.x, tableTop - 3);
        pdf.text("Final", columns.final.x, tableTop - 3);
        pdf.text("Pend.", columns.pending.x, tableTop - 3);
        pdf.text("Estado", columns.status.x, tableTop - 3);
        pdf.setDrawColor(226, 232, 240);
        pdf.line(marginX, tableTop + 6, marginX + contentWidth, tableTop + 6);
      };

      const drawFooter = () => {
        pdf.setDrawColor(226, 232, 240);
        pdf.line(marginX, pageHeight - footerHeight, marginX + contentWidth, pageHeight - footerHeight);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(100, 116, 139);
        pdf.text(`Pagina ${pageNumber}`, pageWidth - marginX, pageHeight - 18, { align: "right" });
      };

      const startPage = () => {
        drawHeader();
        drawFooter();
        y = tableTop + 22;
      };

      const addPage = () => {
        pdf.addPage();
        pageNumber += 1;
        startPage();
      };

      startPage();

      rows.forEach((row, index) => {
        if (y + rowHeight > tableBottom) {
          addPage();
        }

        const exportedFinalGrade =
          typeof row.closure?.finalGrade === "number" && Number.isFinite(row.closure.finalGrade)
            ? row.closure.finalGrade
            : null;
        const statusLabel = row.closure?.status === "closed" ? "Cerrada" : "Abierta";
        const rowTop = y - 13;

        if (index % 2 === 0) {
          pdf.setFillColor(248, 250, 252);
          pdf.rect(marginX, rowTop, contentWidth, rowHeight, "F");
        }

        pdf.setTextColor(15, 23, 42);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.text(String(index + 1), columns.index.x + 2, y + 5);
        const studentLines = pdf.splitTextToSize(row.studentName || "Sin nombre", columns.student.width) as string[];
        pdf.text(studentLines.slice(0, 2), columns.student.x, y);

        pdf.setFont("helvetica", "bold");
        pdf.setTextColor(29, 78, 216);
        pdf.text(formatGradeValue(row.autoGrade), columns.auto.x, y + 5);
        pdf.setTextColor(15, 23, 42);
        pdf.text(formatGradeValue(exportedFinalGrade), columns.final.x, y + 5);
        pdf.setFont("helvetica", "normal");
        pdf.setTextColor(71, 85, 105);
        pdf.text(`${row.pendingUngradedCount}/${row.totalEvaluable}`, columns.pending.x, y + 5);

        if (statusLabel === "Cerrada") {
          pdf.setFillColor(220, 252, 231);
          pdf.setTextColor(22, 101, 52);
        } else {
          pdf.setFillColor(254, 243, 199);
          pdf.setTextColor(180, 83, 9);
        }
        pdf.roundedRect(columns.status.x, y - 10, columns.status.width, 18, 8, 8, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.text(statusLabel, columns.status.x + columns.status.width / 2, y + 2, { align: "center" });

        pdf.setDrawColor(226, 232, 240);
        pdf.line(marginX, rowTop + rowHeight, marginX + contentWidth, rowTop + rowHeight);
        y += rowHeight;
      });

      const fileName = `calificaciones-${selectedCourse.courseName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "materia"}-${new Date()
        .toISOString()
        .slice(0, 10)}.pdf`;
      pdf.save(fileName);
      toast.success("PDF descargado.");
    } catch (error) {
      console.error("No se pudo generar el PDF de calificaciones:", error);
      toast.error("No se pudo descargar el PDF.");
    } finally {
      setExportingGradesPdf(false);
    }
  }, [rows, selectedCourse, selectedCourseId]);

  if (!courses.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Este grupo no tiene materias asignadas.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando calificaciones...
      </div>
    );
  }

  const tableColumnsCount =
    6 +
    (enableCampusTasksGrade ? 1 : 0) +
    (enableCampusFinalExamGrade ? 1 : 0) +
    (enableGlobalExamGrade ? 1 : 0) +
    (enableExtraordinaryExamGrade ? 1 : 0) +
    courseExtraConceptColumns.length;

  const breakdownEditState = breakdownRow
    ? (() => {
        const row = breakdownRow;
        const finalResolution = resolveFinalGradeForRow(row);
        const finalGradeValue = finalResolution.finalGrade;
        const computedFinalInput =
          typeof finalGradeValue === "number" ? finalGradeValue.toFixed(1) : "";
        const finalKey = getDraftKey(row.studentId);
        const hasFinalDraft = Object.prototype.hasOwnProperty.call(draftFinalGrades, finalKey);
        const finalInput = hasFinalDraft ? draftFinalGrades[finalKey] : computedFinalInput;
        const invalidFinal =
          finalResolution.errorMessage !== null ||
          typeof finalGradeValue !== "number" ||
          !Number.isFinite(finalGradeValue) ||
          finalGradeValue < 0 ||
          finalGradeValue > 100;

        const campusTasksInput = getCampusTasksGradeInput(row);
        const campusFinalExamInput = getCampusFinalExamGradeInput(row);
        const globalExamInput = getGlobalExamGradeInput(row);
        const extraordinaryExamInput = getExtraordinaryExamGradeInput(row);

        const campusTasksGradeNum = Number(campusTasksInput);
        const invalidCampusTasksGrade =
          enableCampusTasksGrade &&
          campusTasksInput.trim().length > 0 &&
          (!Number.isFinite(campusTasksGradeNum) ||
            campusTasksGradeNum < 0 ||
            campusTasksGradeNum > 100);
        const campusFinalExamGradeNum = Number(campusFinalExamInput);
        const invalidCampusFinalExamGrade =
          enableCampusFinalExamGrade &&
          campusFinalExamInput.trim().length > 0 &&
          (!Number.isFinite(campusFinalExamGradeNum) ||
            campusFinalExamGradeNum < 0 ||
            campusFinalExamGradeNum > 100);
        const globalExamGradeNum = Number(globalExamInput);
        const invalidGlobalExamGrade =
          enableGlobalExamGrade &&
          globalExamInput.trim().length > 0 &&
          (!Number.isFinite(globalExamGradeNum) ||
            globalExamGradeNum < 0 ||
            globalExamGradeNum > 100);
        const extraordinaryExamGradeNum = Number(extraordinaryExamInput);
        const invalidExtraordinaryExamGrade =
          enableExtraordinaryExamGrade &&
          extraordinaryExamInput.trim().length > 0 &&
          (!Number.isFinite(extraordinaryExamGradeNum) ||
            extraordinaryExamGradeNum < 0 ||
            extraordinaryExamGradeNum > 100);
        const invalidExtraConcepts =
          Boolean(courseExtraConceptsResolution.errorMessage) ||
          courseExtraConceptColumns.some(
            (concept) => parseOptionalExtraPointsInput(getExtraPointInputForRow(row, concept)) === undefined,
          );
        const hasAdditionalInputErrors =
          invalidCampusTasksGrade ||
          invalidCampusFinalExamGrade ||
          invalidGlobalExamGrade ||
          invalidExtraordinaryExamGrade ||
          invalidExtraConcepts ||
          Boolean(finalResolution.campusGrades.errorMessage);
        const isRowProcessing =
          processingAll ||
          processingStudentId === row.studentId ||
          processingNotifyStudentId === row.studentId;
        const canSaveFromBreakdown =
          canManageClosures &&
          !isRowProcessing &&
          finalInput.trim().length > 0 &&
          !invalidFinal &&
          !hasAdditionalInputErrors;

        return {
          row,
          finalKey,
          finalInput,
          computedFinalInput,
          invalidFinal,
          isRowProcessing,
          canSaveFromBreakdown,
        };
      })()
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Materia</span>
          <select
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            {courses.map((course) => (
              <option key={course.courseId} value={course.courseId}>
                {course.courseName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={downloadGradesSummaryPdf}
            disabled={exportingGradesPdf || rows.length === 0}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            <Download size={14} />
            <span>{exportingGradesPdf ? "Generando..." : "Descargar PDF"}</span>
          </button>
          <button
            type="button"
            onClick={openExtraConceptModal}
            disabled={!canManageClosures || !selectedCourseId || processingAll}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            <span className="text-sm leading-none">+</span>
            <span>Concepto Extra</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {canManageClosures ? (
            <button
              type="button"
              onClick={handleCloseCourseForAll}
              disabled={
                processingAll ||
                processingStudentId !== null ||
                processingNotifyStudentId !== null ||
                selectedCourseTasks.length === 0 ||
                rows.length === 0 ||
                openRowsCount === 0
              }
              className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {processingAll ? "Cerrando..." : "Cerrar y completar"}
            </button>
          ) : null}
          <span className="text-xs text-slate-500">
            {canManageClosures
              ? "Puedes guardar/notificar calificación y cerrar o reabrir materia por alumno."
              : "Solo lectura: no tienes permiso para cerrar/reabrir."}
          </span>
        </div>
      </div>

      {selectedCourseSkipsExamTemplates ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Esta materia está clasificada como maestría o diplomado; no requiere cargar examen global ni extraordinario
          para cerrar calificaciones.
        </div>
      ) : null}

      {selectedCourseTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Esta materia no tiene actividades evaluables (quiz/tarea/foro).
        </div>
      ) : (
        <div className="space-y-2">
          <div className="overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Alumno</th>
                <th className="px-3 py-2 text-left">Auto</th>
                {enableCampusTasksGrade ? (
                  <th className="px-3 py-2 text-left">Tareas plantel</th>
                ) : null}
                {enableCampusFinalExamGrade ? (
                  <th className="px-3 py-2 text-left">Examen final plantel</th>
                ) : null}
                {enableGlobalExamGrade ? (
                  <th className="px-3 py-2 text-left">Examen global</th>
                ) : null}
                {enableExtraordinaryExamGrade ? (
                  <th className="px-3 py-2 text-left">Examen extraordinario</th>
                ) : null}
                {courseExtraConceptColumns.map((concept) => (
                  <th key={concept.id} className="px-3 py-2 text-left">
                    {concept.concept}
                  </th>
                ))}
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Pendientes</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={tableColumnsCount}>
                    No hay alumnos en este grupo.
                  </td>
                </tr>
              ) : rows.map((row) => {
                const isClosed = row.closure?.status === "closed";
                const campusTasksInput = getCampusTasksGradeInput(row);
                const campusFinalExamInput = getCampusFinalExamGradeInput(row);
                const globalExamInput = getGlobalExamGradeInput(row);
                const extraordinaryExamInput = getExtraordinaryExamGradeInput(row);
                const finalResolution = resolveFinalGradeForRow(row);
                const finalGradeValue = finalResolution.finalGrade;
                const computedFinalInput =
                  typeof finalGradeValue === "number" ? finalGradeValue.toFixed(1) : "";
                const finalKey = getDraftKey(row.studentId);
                const hasFinalDraft = Object.prototype.hasOwnProperty.call(draftFinalGrades, finalKey);
                const finalInput = hasFinalDraft ? draftFinalGrades[finalKey] : computedFinalInput;
                const invalidFinal =
                  finalResolution.errorMessage !== null ||
                  typeof finalGradeValue !== "number" ||
                  !Number.isFinite(finalGradeValue) ||
                  finalGradeValue < 0 ||
                  finalGradeValue > 100;
                const campusTasksGradeNum = Number(campusTasksInput);
                const invalidCampusTasksGrade =
                  enableCampusTasksGrade &&
                  campusTasksInput.trim().length > 0 &&
                  (!Number.isFinite(campusTasksGradeNum) ||
                    campusTasksGradeNum < 0 ||
                    campusTasksGradeNum > 100);
                const campusFinalExamGradeNum = Number(campusFinalExamInput);
                const invalidCampusFinalExamGrade =
                  enableCampusFinalExamGrade &&
                  campusFinalExamInput.trim().length > 0 &&
                  (!Number.isFinite(campusFinalExamGradeNum) ||
                    campusFinalExamGradeNum < 0 ||
                    campusFinalExamGradeNum > 100);
                const globalExamGradeNum = Number(globalExamInput);
                const invalidGlobalExamGrade =
                  enableGlobalExamGrade &&
                  globalExamInput.trim().length > 0 &&
                  (!Number.isFinite(globalExamGradeNum) ||
                    globalExamGradeNum < 0 ||
                    globalExamGradeNum > 100);
                const extraordinaryExamGradeNum = Number(extraordinaryExamInput);
                const invalidExtraordinaryExamGrade =
                  enableExtraordinaryExamGrade &&
                  extraordinaryExamInput.trim().length > 0 &&
                  (!Number.isFinite(extraordinaryExamGradeNum) ||
                    extraordinaryExamGradeNum < 0 ||
                    extraordinaryExamGradeNum > 100);
                const extraConceptInputsById: Record<string, string> = {};
                const invalidExtraConceptIds = new Set<string>();
                courseExtraConceptColumns.forEach((concept) => {
                  const inputValue = getExtraPointInputForRow(row, concept);
                  extraConceptInputsById[concept.id] = inputValue;
                  if (parseOptionalExtraPointsInput(inputValue) === undefined) {
                    invalidExtraConceptIds.add(concept.id);
                  }
                });
                const invalidExtraConcepts =
                  Boolean(courseExtraConceptsResolution.errorMessage) || invalidExtraConceptIds.size > 0;
                const hasAdditionalInputErrors =
                  invalidCampusTasksGrade ||
                  invalidCampusFinalExamGrade ||
                  invalidGlobalExamGrade ||
                  invalidExtraordinaryExamGrade ||
                  invalidExtraConcepts ||
                  Boolean(finalResolution.campusGrades.errorMessage);
                const isRowProcessing =
                  processingAll ||
                  processingStudentId === row.studentId ||
                  processingNotifyStudentId === row.studentId;

                return (
                  <tr key={row.studentId} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">{row.studentName || "Sin nombre"}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—"}
                    </td>
                    {enableCampusTasksGrade ? (
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={campusTasksInput}
                          onChange={(e) => {
                            const key = getDraftKey(row.studentId);
                            setDraftCampusTasksGrades((prev) => ({ ...prev, [key]: e.target.value }));
                          }}
                          disabled={!canManageClosures || isRowProcessing}
                          className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                            invalidCampusTasksGrade ? "border-red-400" : "border-slate-300"
                          } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                        />
                      </td>
                    ) : null}
                    {enableCampusFinalExamGrade ? (
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={campusFinalExamInput}
                          onChange={(e) => {
                            const key = getDraftKey(row.studentId);
                            setDraftCampusFinalExamGrades((prev) => ({ ...prev, [key]: e.target.value }));
                          }}
                          disabled={!canManageClosures || isRowProcessing}
                          className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                            invalidCampusFinalExamGrade ? "border-red-400" : "border-slate-300"
                          } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                        />
                      </td>
                    ) : null}
                    {enableGlobalExamGrade ? (
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={globalExamInput}
                          onChange={(e) => {
                            const key = getDraftKey(row.studentId);
                            setDraftGlobalExamGrades((prev) => ({ ...prev, [key]: e.target.value }));
                          }}
                          disabled={!canManageClosures || isRowProcessing}
                          className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                            invalidGlobalExamGrade ? "border-red-400" : "border-slate-300"
                          } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                        />
                      </td>
                    ) : null}
                    {enableExtraordinaryExamGrade ? (
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={extraordinaryExamInput}
                          onChange={(e) => {
                            const key = getDraftKey(row.studentId);
                            setDraftExtraordinaryExamGrades((prev) => ({ ...prev, [key]: e.target.value }));
                          }}
                          disabled={!canManageClosures || isRowProcessing}
                          className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                            invalidExtraordinaryExamGrade ? "border-red-400" : "border-slate-300"
                          } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                        />
                      </td>
                    ) : null}
                    {courseExtraConceptColumns.map((concept) => {
                      const conceptInput = extraConceptInputsById[concept.id] ?? "";
                      const invalidConceptInput = invalidExtraConceptIds.has(concept.id);
                      return (
                        <td key={`${row.studentId}-${concept.id}`} className="px-3 py-2">
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={conceptInput}
                            onChange={(event) => {
                              updateExtraPointInputForRow(row, concept, event.target.value);
                            }}
                            disabled={!canManageClosures || isRowProcessing}
                            className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                              invalidConceptInput ? "border-red-400" : "border-slate-300"
                            } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                          />
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={finalInput}
                        onChange={(e) =>
                          setDraftFinalGrades((prev) => ({ ...prev, [finalKey]: e.target.value }))
                        }
                        disabled={!canManageClosures || isRowProcessing}
                        className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                          invalidFinal ? "border-red-400" : "border-slate-300"
                        } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {row.pendingUngradedCount} / {row.totalEvaluable}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-semibold ${
                            isClosed
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {isClosed ? "Cerrada" : "Abierta"}
                        </span>
                        {isClosed && row.closure?.closedAt ? (
                          <span className="text-[11px] text-slate-500">
                            Cierre: {formatDate(row.closure.closedAt)}
                          </span>
                        ) : null}
                        {isClosed && closureOriginLabel(row.closure) ? (
                          <span className="text-[11px] text-slate-500">
                            {closureOriginLabel(row.closure)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-2">
                        <button
                          type="button"
                          onClick={() => setBreakdownStudentId(row.studentId)}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                        >
                          Ver desglose
                        </button>
                      {isClosed ? (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={
                              !canManageClosures ||
                              isRowProcessing ||
                              finalInput.trim().length === 0 ||
                              invalidFinal ||
                              hasAdditionalInputErrors
                            }
                            onClick={() => handleSaveFinalGradeForStudent(row)}
                            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                          >
                            {processingStudentId === row.studentId ? "Guardando..." : "Guardar"}
                          </button>
                          <button
                            type="button"
                            disabled={!canManageClosures || isRowProcessing}
                            onClick={() => handleReopenCourseForStudent(row)}
                            className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                          >
                            {processingStudentId === row.studentId ? "Procesando..." : "Reabrir"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={
                              !canManageClosures ||
                              isRowProcessing ||
                              finalInput.trim().length === 0 ||
                              invalidFinal ||
                              hasAdditionalInputErrors
                            }
                            onClick={() => handleSaveAndNotifyFinalGradeForStudent(row)}
                            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                          >
                            {processingNotifyStudentId === row.studentId
                              ? "Notificando..."
                              : "Guardar y notificar"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              !canManageClosures ||
                              isRowProcessing ||
                              finalInput.trim().length === 0 ||
                              invalidFinal ||
                              hasAdditionalInputErrors
                            }
                            onClick={() => handleCloseCourseForStudent(row)}
                            className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                          >
                            {processingStudentId === row.studentId ? "Procesando..." : "Cerrar"}
                          </button>
                        </div>
                      )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
          <p className="px-1 text-xs text-slate-500">
            Auto es la suma de puntos ganados en tareas, foros y quizzes con calificación numérica.
          </p>
        </div>
      )}

      {extraConceptModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Conceptos extra de la materia</h3>
              <p className="mt-1 text-sm text-slate-600">
                Materia: <span className="font-medium">{selectedCourse?.courseName ?? "Sin materia"}</span>. Se aplica a todos los alumnos del grupo.
              </p>
            </div>

            <div className="space-y-3 px-5 py-4">
              {extraConceptModalDrafts.length === 0 ? (
                <p className="text-sm text-slate-500">Sin conceptos extra registrados.</p>
              ) : (
                extraConceptModalDrafts.map((entry) => {
                  const filteredSuggestions = getFilteredSuggestionsForDraft(entry.id, entry.concept);
                  const showSuggestions =
                    activeExtraConceptDropdownId === entry.id &&
                    !savingExtraConceptModal &&
                    filteredSuggestions.length > 0;

                  return (
                    <div key={entry.id} className="flex items-start gap-2">
                      <div className="relative min-w-0 flex-1">
                        <input
                          type="text"
                          value={entry.concept}
                          autoComplete="off"
                          onFocus={() => setActiveExtraConceptDropdownId(entry.id)}
                          onBlur={() => {
                            window.setTimeout(() => {
                              setActiveExtraConceptDropdownId((prev) => (prev === entry.id ? null : prev));
                            }, 120);
                          }}
                          onChange={(event) => {
                            updateExtraConceptModalDraft(entry.id, { concept: event.target.value });
                            setActiveExtraConceptDropdownId(entry.id);
                            if (extraConceptModalError) setExtraConceptModalError(null);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setActiveExtraConceptDropdownId((prev) => (prev === entry.id ? null : prev));
                            }
                          }}
                          disabled={savingExtraConceptModal}
                          placeholder="Concepto (ej. Clase en vivo)"
                          className="min-w-0 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                        />
                        {showSuggestions ? (
                          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                            <ul className="max-h-48 overflow-y-auto py-1">
                              {filteredSuggestions.map((suggestion) => (
                                <li key={`${entry.id}-${suggestion}`}>
                                  <button
                                    type="button"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => {
                                      updateExtraConceptModalDraft(entry.id, { concept: suggestion });
                                      setActiveExtraConceptDropdownId(null);
                                      if (extraConceptModalError) setExtraConceptModalError(null);
                                    }}
                                    className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                                  >
                                    {suggestion}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </div>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={entry.defaultPoints}
                        onChange={(event) => {
                          updateExtraConceptModalDraft(entry.id, { defaultPoints: event.target.value });
                          if (extraConceptModalError) setExtraConceptModalError(null);
                        }}
                        disabled={savingExtraConceptModal}
                        placeholder="Pts iniciales (opcional)"
                        className="w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                      />
                      <button
                        type="button"
                        onClick={() => removeExtraConceptModalDraft(entry.id)}
                        disabled={savingExtraConceptModal}
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}

              <button
                type="button"
                onClick={addExtraConceptModalRow}
                disabled={savingExtraConceptModal}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                <span className="text-sm leading-none">+</span>
                <span>Agregar concepto</span>
              </button>
              {extraConceptModalError ? (
                <p className="text-sm font-medium text-red-600">{extraConceptModalError}</p>
              ) : null}
              <p className="text-xs text-slate-500">
                Pts iniciales es opcional. Si lo capturas, se sugiere ese puntaje para todos los alumnos al crear el
                concepto.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={closeExtraConceptModal}
                disabled={savingExtraConceptModal}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSaveExtraConceptModal}
                disabled={savingExtraConceptModal}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {savingExtraConceptModal ? "Guardando..." : "Guardar conceptos"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {breakdownRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-4xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">Desglose de Auto</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Alumno: <span className="font-medium">{breakdownRow.studentName || "Sin nombre"}</span> | Materia:{" "}
                  <span className="font-medium">{selectedCourse?.courseName ?? "Sin materia"}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBreakdownStudentId(null)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cerrar
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Auto (suma)</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {typeof breakdownRow.autoGrade === "number" ? breakdownRow.autoGrade.toFixed(1) : "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Actividades</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">{breakdownRow.totalEvaluable}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Con puntos</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {breakdownRow.autoBreakdown.filter((item) => typeof item.grade === "number").length}
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.08em] text-slate-500">Pendientes</p>
                  <p className="mt-1 text-base font-semibold text-slate-900">
                    {breakdownRow.pendingUngradedCount}/{breakdownRow.totalEvaluable}
                  </p>
                </div>
              </div>

              {breakdownEditState ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                        Calificación final
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={breakdownEditState.finalInput}
                        onChange={(event) =>
                          setDraftFinalGrades((prev) => ({
                            ...prev,
                            [breakdownEditState.finalKey]: event.target.value,
                          }))
                        }
                        disabled={!canManageClosures || breakdownEditState.isRowProcessing}
                        className={`mt-1 w-32 rounded-lg border px-2 py-1 text-sm ${
                          breakdownEditState.invalidFinal ? "border-red-400" : "border-slate-300"
                        } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                      />
                    </div>
                    <div className="text-xs text-slate-600">
                      <p>
                        Sugerida por suma:{" "}
                        <span className="font-semibold">
                          {breakdownEditState.computedFinalInput || "—"}
                        </span>
                      </p>
                      <p>
                        {canManageClosures
                          ? "Puedes editar y guardar sin cerrar el desglose."
                          : "Solo lectura: no tienes permisos para guardar."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleSaveFinalGradeForStudent(breakdownEditState.row)}
                      disabled={!breakdownEditState.canSaveFromBreakdown}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                    >
                      {processingStudentId === breakdownEditState.row.studentId ? "Guardando..." : "Guardar calificación"}
                    </button>
                  </div>
                  {breakdownEditState.invalidFinal ? (
                    <p className="mt-2 text-xs font-medium text-red-600">
                      Revisa los valores capturados. La calificación final debe estar entre 0 y 100.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-left">Actividad</th>
                      <th className="px-3 py-2 text-left">Tipo</th>
                      <th className="px-3 py-2 text-left">Estado</th>
                      <th className="px-3 py-2 text-left">Entregada</th>
                      <th className="px-3 py-2 text-left">Evaluada</th>
                      <th className="px-3 py-2 text-left">Puntos sumados</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {breakdownRow.autoBreakdown.map((item) => (
                      <tr key={`${breakdownRow.studentId}-${item.classId}`}>
                        <td className="px-3 py-2 text-slate-900">
                          <p className="font-medium">{item.classTitle || "Sin título"}</p>
                          <p className="text-xs text-slate-500">{item.classId}</p>
                        </td>
                        <td className="px-3 py-2 text-slate-700">{taskTypeLabel(item.classType)}</td>
                        <td className="px-3 py-2 text-slate-700">
                          {!item.hasSubmission
                            ? "Sin entrega"
                            : typeof item.grade === "number"
                            ? "Con calificación"
                            : item.isMarkedGraded
                            ? "Calificada sin puntaje"
                            : "Sin calificar"}
                        </td>
                        <td className="px-3 py-2 text-slate-700">
                          {item.submittedAt ? formatDateTime(item.submittedAt) : "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-700">
                          {item.gradedAt ? (
                            <div className="space-y-0.5">
                              <p>{formatDateTime(item.gradedAt)}</p>
                              <p className="text-xs text-slate-500">{item.gradedByName || "Docente"}</p>
                            </div>
                          ) : item.isMarkedGraded ? (
                            "Calificada sin fecha"
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-900">
                          {typeof item.grade === "number" ? item.grade.toFixed(1) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-slate-500">
                Solo se suman las actividades que tienen calificación numérica.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {examTemplatesModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Plantillas requeridas para cierre</h3>
              <p className="mt-1 text-sm text-slate-600">
                Para cerrar calificaciones de{" "}
                <span className="font-medium">{selectedCourse?.courseName ?? "la materia"}</span>, el examen
                extraordinario siempre requiere Word. El examen global solo requiere Word si no hay una plantilla global
                ligada a la materia.
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              {!hasRequiredExamTemplates ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  Pendiente para avanzar: {missingRequiredExamTemplateLabels.join(" y ")}.
                </div>
              ) : (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Los requisitos de plantillas están cubiertos. Puedes continuar con el cierre.
                </div>
              )}

              <div className="flex flex-wrap gap-2 text-[11px] text-slate-600">
                {Object.entries(EXAM_QUESTION_TYPE_LABELS).map(([type, label]) => (
                  <span
                    key={type}
                    className="rounded-full border border-slate-200 bg-white px-2 py-1 font-medium"
                  >
                    {label}
                  </span>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => downloadExamTemplateExample("extraordinary")}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Descargar formato extraordinario
                </button>
                <button
                  type="button"
                  onClick={() => downloadExamTemplateExample("global")}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  Descargar formato global
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                {(["extraordinary", "global"] as ExamTemplateKind[]).map((kind) => {
                  const template = selectedCourseExamTemplates[kind];
                  const linkedGlobalTemplate =
                    kind === "global" ? selectedExistingGlobalExamTemplate ?? null : null;
                  const isGlobalSatisfiedByLinkedTemplate = kind === "global" && Boolean(linkedGlobalTemplate);
                  const isTemplateReady =
                    kind === "extraordinary"
                      ? Boolean(template)
                      : Boolean(linkedGlobalTemplate) || Boolean(template);
                  const uploading = uploadingTemplateKind === kind;
                  return (
                    <div key={kind} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {EXAM_TEMPLATE_KIND_LABELS[kind]}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {isGlobalSatisfiedByLinkedTemplate
                                ? `Examen global ligado a la materia: ${linkedGlobalTemplate?.title ?? "Plantilla global"}`
                                : template
                                  ? `${template.fileName} · ${formatFileSize(template.fileSize)}`
                                  : "Pendiente de carga (.doc o .docx)"}
                          </p>
                          {template?.uploadedAt ? (
                            <p className="mt-1 text-[11px] text-slate-500">
                              Cargada: {formatDateTime(template.uploadedAt)}
                            </p>
                          ) : null}
                          {!isGlobalSatisfiedByLinkedTemplate && template?.downloadUrl ? (
                            <div className="mt-2 flex flex-wrap items-center gap-3">
                              <button
                                type="button"
                                onClick={() => void openExamTemplatePreview(template)}
                                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
                              >
                                <Eye size={13} />
                                Vista alumno
                              </button>
                              <a
                                href={template.downloadUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:underline"
                              >
                                <ExternalLink size={13} />
                                Abrir archivo
                              </a>
                            </div>
                          ) : null}
                        </div>
                        <span
                          className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                            isTemplateReady
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {isTemplateReady ? "Lista" : "Falta"}
                        </span>
                      </div>

                      {isGlobalSatisfiedByLinkedTemplate ? (
                        <p className="mt-3 text-xs font-medium text-emerald-700">
                          No se requiere subir Word para examen global porque ya existe una plantilla ligada.
                        </p>
                      ) : (
                        <label
                          className={`mt-3 inline-flex cursor-pointer items-center justify-center rounded-lg border px-3 py-2 text-xs font-semibold ${
                            canManageClosures
                              ? "border-blue-200 bg-white text-blue-700 hover:bg-blue-50"
                              : "cursor-not-allowed border-slate-200 text-slate-400"
                          }`}
                        >
                          {uploading ? "Cargando..." : template ? "Reemplazar Word" : "Subir Word"}
                          <input
                            type="file"
                            accept={EXAM_TEMPLATE_ACCEPT}
                            className="hidden"
                            disabled={!canManageClosures || uploadingTemplateKind !== null}
                            onChange={(event) => {
                              const file = event.target.files?.[0] ?? null;
                              void handleUploadExamTemplate(kind, file);
                              event.target.value = "";
                            }}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => resolveExamTemplatesModal(false)}
                disabled={uploadingTemplateKind !== null}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => resolveExamTemplatesModal(true)}
                disabled={!hasRequiredExamTemplates || uploadingTemplateKind !== null}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              >
                Continuar con cierre
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {examTemplatePreview ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/70 px-4 py-6">
          <div className="flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                  Vista alumno
                </p>
                <h3 className="mt-1 text-lg font-semibold text-slate-900">
                  {EXAM_TEMPLATE_KIND_LABELS[examTemplatePreview.template.kind]}
                </h3>
                <p className="mt-1 text-sm text-slate-600">
                  {examTemplatePreview.template.fileName} · {formatFileSize(examTemplatePreview.template.fileSize)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={examTemplatePreview.template.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                >
                  <ExternalLink size={14} />
                  Abrir
                </a>
                <button
                  type="button"
                  onClick={() => setExamTemplatePreview(null)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-100"
                  aria-label="Cerrar previsualizacion"
                >
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-100 p-5">
              {examTemplatePreview.loading ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
                  Extrayendo preguntas del archivo...
                </div>
              ) : examTemplatePreview.error ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
                  <p className="font-semibold">No se pudo generar la vista de preguntas.</p>
                  <p className="mt-1">{examTemplatePreview.error}</p>
                  <p className="mt-3 text-xs">
                    Verifica que el archivo tenga preguntas numeradas, opciones marcadas con letras y una respuesta
                    correcta indicada, o usa el formato
                    descargable de la plataforma.
                  </p>
                </div>
              ) : (
                <section className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
                        Examen habilitado
                      </p>
                      <h2 className="mt-2 text-2xl font-semibold text-slate-900">
                        {selectedCourse?.courseName ?? "Materia"}
                      </h2>
                      <p className="mt-1 text-sm text-slate-600">
                        {examTemplatePreview.questions.length} pregunta
                        {examTemplatePreview.questions.length === 1 ? "" : "s"} detectada
                        {examTemplatePreview.questions.length === 1 ? "" : "s"} desde la plantilla.
                      </p>
                    </div>
                    <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-right">
                      <p className="text-xs uppercase tracking-[0.14em] text-red-500">Tiempo restante</p>
                      <p className="text-2xl font-semibold text-red-700">{GLOBAL_EXAM_DURATION_MINUTES}:00</p>
                    </div>
                  </div>

                  <div className="mt-6 space-y-4">
                    {examTemplatePreview.questions.map((question, index) => (
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
                              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm"
                            >
                              <div className="flex items-start gap-3">
                                <input
                                  type="radio"
                                  name={`preview-answer-${question.id}`}
                                  disabled
                                  className="mt-1 h-4 w-4 accent-blue-600"
                                />
                                <span>{option.text}</span>
                              </div>
                            </label>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>

                  <button
                    type="button"
                    disabled
                    className="mt-6 inline-flex cursor-not-allowed items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white opacity-70"
                  >
                    Enviar examen
                  </button>
                </section>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {signatureModalContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-3xl rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">Firma digital para cierre de calificaciones</h3>
              <p className="mt-1 text-sm text-slate-600">
                Materia: <span className="font-medium">{signatureModalContext.courseName}</span> | Alumnos a cerrar:{" "}
                <span className="font-medium">{signatureModalContext.rows.length}</span>
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Nombre del profesor firmante
                  </label>
                  <input
                    type="text"
                    value={signerNameInput}
                    onChange={(event) => {
                      setSignerNameInput(event.target.value);
                      if (signatureError) setSignatureError(null);
                    }}
                    placeholder="Escribe tu nombre completo"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                  />
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <p>
                    Fecha de solicitud:{" "}
                    <span className="font-medium">{formatDateTime(signatureModalContext.requestedAt)}</span>
                  </p>
                  <p className="mt-1">
                    Grupo: <span className="font-medium">{groupId}</span>
                  </p>
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                    Firma manuscrita
                  </label>
                  <button
                    type="button"
                    onClick={clearSignatureCanvas}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    Limpiar firma
                  </button>
                </div>
                <canvas
                  ref={signatureCanvasRef}
                  className="h-40 w-full rounded-lg border border-slate-300 bg-white"
                  style={{ touchAction: "none" }}
                  onPointerDown={handleSignaturePointerDown}
                  onPointerMove={handleSignaturePointerMove}
                  onPointerUp={handleSignaturePointerEnd}
                  onPointerLeave={handleSignaturePointerEnd}
                  onPointerCancel={handleSignaturePointerEnd}
                />
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                  Resumen de calificaciones a cerrar
                </p>
                <div className="mt-2 max-h-32 overflow-auto text-xs text-slate-700">
                  {signatureModalContext.rows.slice(0, 6).map((row) => (
                    <p key={`${row.studentId}-${row.finalGrade}`} className="py-0.5">
                      {row.studentName || "Sin nombre"} | Final {row.finalGrade.toFixed(1)} | Auto{" "}
                      {typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—"} | Pendientes{" "}
                      {row.pendingUngradedCount}/{row.totalEvaluable}
                    </p>
                  ))}
                  {signatureModalContext.rows.length > 6 ? (
                    <p className="pt-1 text-slate-500">
                      ... y {signatureModalContext.rows.length - 6} alumno(s) más.
                    </p>
                  ) : null}
                </div>
              </div>

              {signatureError ? (
                <p className="text-sm font-medium text-red-600">{signatureError}</p>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => resolveSignatureModal(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDigitalSignature}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Firmar y continuar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmationModalContext ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 px-4 py-6">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4">
              <h3 className="text-lg font-semibold text-slate-900">{confirmationModalContext.title}</h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-slate-700">{confirmationModalContext.message}</p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                type="button"
                onClick={() => resolveConfirmationModal(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100"
              >
                {confirmationModalContext.cancelLabel ?? "Cancelar"}
              </button>
              <button
                type="button"
                onClick={() => resolveConfirmationModal(true)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                  confirmationModalContext.tone === "danger"
                    ? "bg-red-600 hover:bg-red-500"
                    : confirmationModalContext.tone === "warning"
                      ? "bg-amber-600 hover:bg-amber-500"
                      : "bg-slate-900 hover:bg-slate-800"
                }`}
              >
                {confirmationModalContext.confirmLabel ?? "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
