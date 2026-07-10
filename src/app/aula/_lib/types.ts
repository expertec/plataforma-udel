import type { LiveClassSession } from "@/lib/live-classes/types";

/**
 * Espejo del tipo FeedClass de StudentFeedPageClient. Ambas interfaces describen
 * exactamente el mismo documento de clase; si uno cambia, el otro debe seguirlo.
 */
export type FeedClass = {
  id: string;
  classDocId?: string;
  title: string;
  type: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  enrollmentId?: string;
  groupId?: string;
  groupName?: string;
  groupIsInPerson?: boolean;
  teacherId?: string;
  teacherName?: string;
  classTitle?: string;
  videoUrl?: string;
  audioUrl?: string;
  content?: string;
  images?: string[];
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string;
  assignmentSubmissionType?: "file" | "audio";
  isClassroomActivity?: boolean;
  showInStudentPlatform?: boolean;
  lessonTitle?: string;
  lessonName?: string;
  likesCount?: number;
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
  forumPointValue?: number;
  liveSession?: LiveClassSession | null;
  studyOnly?: boolean;
};

export type CourseClosureState = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  manualOverride?: boolean;
  pendingUngradedCount?: number;
  closedAt?: Date | null;
  reopenedAt?: Date | null;
  updatedAt?: Date | null;
};

export type BillingBlockedState = {
  blockType?: "overdue" | "missingContact";
  reason: string;
  amount?: number;
  overdueRows?: Array<{
    campus?: string;
    concept: string;
    dueDate?: string;
    amount?: number;
    daysOverdue?: number;
  }>;
  clabe?: string;
  bank?: string;
};

export type FinanceStatus = {
  success: boolean;
  data?: {
    clabe?: { clabe?: string; bank?: string };
    hasOverduePayments?: boolean;
    totalOverdueAmount?: number;
    overdueCount?: number;
    overduePaymentsCount?: number;
    overdueReceivablesCount?: number;
    overdueDetails?:
      | Array<{
          concept?: string;
          amount?: number;
          dueDate?: string;
          daysOverdue?: number;
          campus?: string;
        }>
      | string;
    overdueDetailsText?: string;
    details?: string;
    hasActivePaymentAgreement?: boolean;
    accessGrantedByAgreement?: boolean;
  };
};

export type FinanceValidationDailyCache = {
  version: 1;
  dateKey: string;
  checkedAt: string;
  phone: string;
  whatsapp: string;
  email: string;
  status: "ok" | "blocked" | "missingContact";
  blocked?: BillingBlockedState;
};

export type ProgressSnapshot = {
  progress: Record<string, number>;
  completed: Record<string, boolean>;
  seen: Record<string, boolean>;
};

export type CurriculumClass = {
  id: string;
  title: string;
  type: string;
  index: number;
};

export type CurriculumLesson = {
  lessonId: string;
  lessonTitle: string;
  items: CurriculumClass[];
};

export type CurriculumCourse = {
  courseId: string;
  courseTitle: string;
  lessons: CurriculumLesson[];
};
