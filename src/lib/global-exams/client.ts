import { auth } from "@/lib/firebase/client";
import type {
  GlobalExamAssignmentRecord,
  GlobalExamAttemptCompletionReason,
  GlobalExamAttemptRecord,
  GlobalExamQuestion,
  GlobalExamTemplateRecord,
  StudentVisibleGlobalExamQuestion,
} from "@/lib/global-exams/types";

type ApiResponse<T> = {
  success?: boolean;
  error?: string;
  data?: T;
};

export type GlobalExamAttemptPayload = {
  assignment: GlobalExamAssignmentRecord;
  template: Pick<
    GlobalExamTemplateRecord,
    "id" | "title" | "description" | "courseId" | "courseName" | "questionCount" | "passScore" | "maxAttempts"
  >;
  questions: StudentVisibleGlobalExamQuestion[];
  attempts: GlobalExamAttemptRecord[];
  session: {
    durationMinutes: number;
    startedAt: string;
    deadlineAt: string;
  };
};

async function getSessionToken(): Promise<string> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("No hay sesion activa");
  }
  return currentUser.getIdToken();
}

async function callApi<T>(input: string, init?: RequestInit): Promise<T> {
  const token = await getSessionToken();
  return callApiWithToken<T>(input, token, init);
}

async function callApiWithToken<T>(
  input: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T>;
  if (!response.ok || payload.success !== true || payload.data === undefined) {
    throw new Error(payload.error || "No se pudo completar la operacion");
  }
  return payload.data;
}

export async function fetchGlobalExamTemplates(): Promise<GlobalExamTemplateRecord[]> {
  return callApi<GlobalExamTemplateRecord[]>("/api/global-exams/templates");
}

export async function createGlobalExamTemplate(payload: {
  title: string;
  description: string;
  courseId?: string;
  courseName?: string;
  status: "draft" | "published";
  questions: GlobalExamQuestion[];
}): Promise<GlobalExamTemplateRecord> {
  return callApi<GlobalExamTemplateRecord>("/api/global-exams/templates", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function updateGlobalExamTemplate(
  templateId: string,
  payload: Partial<{
    title: string;
    description: string;
    courseId: string;
    courseName: string;
    status: "draft" | "published";
    questions: GlobalExamQuestion[];
  }>,
): Promise<GlobalExamTemplateRecord> {
  return callApi<GlobalExamTemplateRecord>(`/api/global-exams/templates/${templateId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function fetchGlobalExamAssignments(): Promise<GlobalExamAssignmentRecord[]> {
  return callApi<GlobalExamAssignmentRecord[]>("/api/global-exams/assignments");
}

export async function resolveGlobalExamCandidateEnrollments(
  studentId: string,
  templateId: string,
): Promise<
  Array<{
    enrollmentId: string;
    groupId: string;
    groupName: string;
    courseId: string;
    courseName: string;
    plantelId: string;
    plantelName: string;
  }>
> {
  const query = new URLSearchParams({
    studentId,
    templateId,
  });
  return callApi<
    Array<{
      enrollmentId: string;
      groupId: string;
      groupName: string;
      courseId: string;
      courseName: string;
      plantelId: string;
      plantelName: string;
    }>
  >(`/api/global-exams/assignments/resolve?${query.toString()}`);
}

export async function createGlobalExamAssignment(payload: {
  templateId: string;
  studentId: string;
  groupId: string;
  reason: "failed_course" | "late_joiner";
  enabled: boolean;
}): Promise<GlobalExamAssignmentRecord> {
  return callApi<GlobalExamAssignmentRecord>("/api/global-exams/assignments", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function updateGlobalExamAssignment(
  assignmentId: string,
  payload: {
    enabled: boolean;
  },
): Promise<GlobalExamAssignmentRecord> {
  return callApi<GlobalExamAssignmentRecord>(`/api/global-exams/assignments/${assignmentId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function fetchGlobalExamAttemptPayload(
  assignmentId: string,
): Promise<GlobalExamAttemptPayload> {
  return callApi<GlobalExamAttemptPayload>(`/api/global-exams/assignments/${assignmentId}/attempt`);
}

export async function submitGlobalExamAttempt(
  assignmentId: string,
  answers: Record<string, string>,
  options?: {
    completionReason?: GlobalExamAttemptCompletionReason;
    token?: string;
    keepalive?: boolean;
  },
): Promise<{
  attempt: {
    id: string;
    attemptNumber: number;
    score: number;
    passed: boolean;
    correctAnswers: number;
    totalQuestions: number;
  };
  assignment: GlobalExamAssignmentRecord;
  attemptsRemaining: number;
  gradeSynced: boolean;
  bestScore: number | null;
  status: string;
}> {
  const payload = {
    answers,
    completionReason: options?.completionReason,
  };

  if (options?.token) {
    return callApiWithToken<{
      attempt: {
        id: string;
        attemptNumber: number;
        score: number;
        passed: boolean;
        correctAnswers: number;
        totalQuestions: number;
      };
      assignment: GlobalExamAssignmentRecord;
      attemptsRemaining: number;
      gradeSynced: boolean;
      bestScore: number | null;
      status: string;
    }>(`/api/global-exams/assignments/${assignmentId}/attempt`, options.token, {
      method: "POST",
      keepalive: options.keepalive,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }

  return callApi<{
    attempt: {
      id: string;
      attemptNumber: number;
      score: number;
      passed: boolean;
      correctAnswers: number;
      totalQuestions: number;
    };
    assignment: GlobalExamAssignmentRecord;
    attemptsRemaining: number;
    gradeSynced: boolean;
    bestScore: number | null;
    status: string;
  }>(`/api/global-exams/assignments/${assignmentId}/attempt`, {
    method: "POST",
    keepalive: options?.keepalive,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

export async function getGlobalExamSessionToken(): Promise<string> {
  return getSessionToken();
}
