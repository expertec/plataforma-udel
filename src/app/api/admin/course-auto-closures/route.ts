import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireAdminTeacherAccess,
  type AdminTeacherAccessContext,
} from "@/lib/server/require-admin-teacher-access";
import {
  requireTeacherAccess,
  TeacherAccessError,
  type TeacherAccessContext,
} from "@/lib/server/require-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FirestoreRecord = Record<string, unknown>;

type CourseEntry = {
  courseId: string;
  courseName: string;
  enabledAt: admin.firestore.Timestamp | null;
};

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

type Submission = {
  id: string;
  classId: string;
  classDocId?: string;
  courseId?: string;
  lessonId?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAt: admin.firestore.Timestamp | null;
  status: string;
  grade?: number;
  answers?: Array<Record<string, unknown>>;
  gradedAt: admin.firestore.Timestamp | null;
};

type StudentCourseCalculation = {
  autoGrade: number | null;
  pendingUngradedCount: number;
  gradedCount: number;
  totalEvaluable: number;
  finalGrade: number | null;
  manualOverride: boolean;
  extraConcepts: unknown[];
  extraPointsTotal: number;
  campusTasksGrade: number | null;
  campusFinalExamGrade: number | null;
  globalExamGrade: number | null;
  extraordinaryExamGrade: number | null;
};

type CourseProcessResult = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  enabledAt: string;
  eligible: boolean;
  dryRun: boolean;
  closedCount: number;
  alreadyClosedCount: number;
  skippedInvalidGradeCount: number;
  openCount: number;
};

type ClosureReviewItem = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  teacherId: string;
  teacherName: string;
  enabledAt: string;
  estimatedCloseAt: string;
  daysSinceEnabled: number;
  weeksSinceEnabled: number;
  daysUntilDue: number;
  due: boolean;
  reviewReady: boolean;
  closedCount: number;
  openCount: number;
  totalCount: number;
};

type ManualCloseBody = {
  action?: unknown;
  groupId?: unknown;
  courseId?: unknown;
};

type ClosureActor = {
  closedByType: "system" | "teacher";
  closureTrigger: "automatic" | "manual";
  closedById: string;
  closedByName: string;
};

type ClosureReviewAccessContext = TeacherAccessContext & {
  plantelIds: string[];
  canClose: boolean;
};

const DEFAULT_AUTO_CLOSE_DAYS = 40;
const REVIEW_START_DAYS = 6 * 7;
const REVIEW_DUE_DAYS = 7 * 7;
const SYSTEM_CLOSER_ID = "system";
const SYSTEM_CLOSER_NAME = "Sistema";

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): FirestoreRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FirestoreRecord)
    : {};
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asTimestampOrNull(value: unknown): admin.firestore.Timestamp | null {
  if (!value) return null;
  if (value instanceof admin.firestore.Timestamp) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return admin.firestore.Timestamp.fromDate(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return admin.firestore.Timestamp.fromMillis(value);
  }
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        const millis = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(millis) ? admin.firestore.Timestamp.fromMillis(millis) : null;
      } catch {
        return null;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const date = (value as { toDate: () => Date }).toDate();
        return Number.isFinite(date.getTime()) ? admin.firestore.Timestamp.fromDate(date) : null;
      } catch {
        return null;
      }
    }
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      return new admin.firestore.Timestamp(
        seconds,
        typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0,
      );
    }
  }
  return null;
}

function roundGrade(value: number): number {
  return Math.round(value * 10) / 10;
}

function normalizeQuizPointValue(value: unknown): number {
  const parsed = asNumberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : 1;
}

function extractBearerToken(header: string | null): string {
  if (!header) return "";
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return "";
  return trimmed.slice(7).trim();
}

function assertCronAccess(request: NextRequest): void {
  const configuredSecret =
    asTrimmedString(process.env.COURSE_AUTO_CLOSE_SECRET) ||
    asTrimmedString(process.env.CRON_SECRET);
  if (!configuredSecret && process.env.NODE_ENV === "production") {
    throw new RouteAccessError(500, "Configura COURSE_AUTO_CLOSE_SECRET o CRON_SECRET.");
  }
  if (!configuredSecret) return;

  const incomingSecret =
    extractBearerToken(request.headers.get("authorization")) ||
    asTrimmedString(request.headers.get("x-cron-secret"));
  if (incomingSecret !== configuredSecret) {
    throw new RouteAccessError(401, "No autorizado");
  }
}

function resolveAutoCloseDays(): number {
  const configured = Number(process.env.COURSE_AUTO_CLOSE_DAYS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_AUTO_CLOSE_DAYS;
}

function daysBetween(start: admin.firestore.Timestamp, endMs: number): number {
  return Math.floor((endMs - start.toMillis()) / (24 * 60 * 60 * 1000));
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => asTrimmedString(item))
        .filter(Boolean),
    ),
  );
}

function getUserPlantelIds(data: FirestoreRecord): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function isAdminReviewRole(role: TeacherAccessContext["role"]): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

function isCoordinatorReviewRole(role: TeacherAccessContext["role"]): boolean {
  return role === "coordinadorPlantel" || role === "director";
}

async function requireClosureReviewAccess(request: NextRequest): Promise<ClosureReviewAccessContext> {
  const context = await requireTeacherAccess(request);
  if (!isAdminReviewRole(context.role) && !isCoordinatorReviewRole(context.role)) {
    throw new RouteAccessError(403, "Acceso restringido a administradores y coordinadores");
  }

  const userSnap = await getAdminFirestore().collection("users").doc(context.uid).get();
  const userData = (userSnap.data() ?? {}) as FirestoreRecord;

  return {
    ...context,
    plantelIds: getUserPlantelIds(userData),
    canClose: isAdminReviewRole(context.role),
  };
}

function canReviewGroup(params: {
  access: ClosureReviewAccessContext;
  groupData: FirestoreRecord;
}): boolean {
  const { access, groupData } = params;
  if (access.canClose) return true;

  const plantelId = asTrimmedString(groupData.plantelId);
  if (plantelId && access.plantelIds.includes(plantelId)) return true;

  const isOnlineGroup = groupData.isInPerson !== true;
  const coordinatorId = asTrimmedString(groupData.coordinatorId);
  return isOnlineGroup && coordinatorId === access.uid;
}

function toGroupCourses(data: FirestoreRecord): CourseEntry[] {
  if (Array.isArray(data.courses)) {
    const courses = data.courses
      .map((entry): CourseEntry | null => {
        if (!entry || typeof entry !== "object") return null;
        const course = entry as FirestoreRecord;
        const courseId = asTrimmedString(course.courseId);
        if (!courseId) return null;
        return {
          courseId,
          courseName: asTrimmedString(course.courseName),
          enabledAt: asTimestampOrNull(course.enabledAt),
        };
      })
      .filter((entry): entry is CourseEntry => entry !== null);
    if (courses.length > 0) return courses;
  }

  const legacyCourseId = asTrimmedString(data.courseId);
  if (!legacyCourseId) return [];
  return [
    {
      courseId: legacyCourseId,
      courseName: asTrimmedString(data.courseName),
      enabledAt: asTimestampOrNull(data.courseEnabledAt),
    },
  ];
}

async function loadCourseTasks(
  db: admin.firestore.Firestore,
  courseId: string,
): Promise<Task[]> {
  const lessonsSnap = await db
    .collection("courses")
    .doc(courseId)
    .collection("lessons")
    .orderBy("order", "asc")
    .get();

  const taskGroups = await Promise.all(
    lessonsSnap.docs.map(async (lessonDoc) => {
      const classesSnap = await lessonDoc.ref.collection("classes").orderBy("order", "asc").get();
      const tasks: Task[] = [];
      classesSnap.docs.forEach((classDoc) => {
        const data = classDoc.data() as FirestoreRecord;
        const isForum = data.forumEnabled === true;
        const isQuiz = asTrimmedString(data.type) === "quiz";
        const isAssignment = data.hasAssignment === true;
        if (!isForum && !isQuiz && !isAssignment) return;
        tasks.push({
          id: classDoc.id,
          lessonId: lessonDoc.id,
          title: asTrimmedString(data.title) || "Sin titulo",
          classType: isForum ? "forum" : isQuiz ? "quiz" : isAssignment ? "assignment" : "activity",
        });
      });
      return tasks;
    }),
  );

  return taskGroups.flat();
}

async function loadQuizConfigByClass(
  db: admin.firestore.Firestore,
  courseId: string,
  tasks: Task[],
): Promise<Record<string, QuizClassConfig>> {
  const quizTasks = tasks.filter((task) => task.classType === "quiz");
  const entries = await Promise.all(
    quizTasks.map(async (task) => {
      const questionsSnap = await db
        .collection("courses")
        .doc(courseId)
        .collection("lessons")
        .doc(task.lessonId)
        .collection("classes")
        .doc(task.id)
        .collection("questions")
        .get();

      let totalPoints = 0;
      const questionsById: Record<string, QuizQuestionConfig> = {};
      questionsSnap.docs.forEach((questionDoc) => {
        const data = questionDoc.data() as FirestoreRecord;
        const pointValue = normalizeQuizPointValue(data.pointValue);
        totalPoints = Math.round((totalPoints + pointValue) * 100) / 100;
        const options = Array.isArray(data.options) ? data.options : [];
        const correctOptionIds = options
          .map((option) => {
            if (!option || typeof option !== "object") return "";
            const raw = option as FirestoreRecord;
            if (raw.isCorrect !== true) return "";
            return asTrimmedString(raw.id) || asTrimmedString(raw.text);
          })
          .filter(Boolean);
        questionsById[questionDoc.id] = { pointValue, correctOptionIds };
      });

      return [task.id, { totalPoints, questionsById }] as const;
    }),
  );

  return Object.fromEntries(entries);
}

function toSubmission(id: string, data: FirestoreRecord): Submission {
  const status = asTrimmedString(data.status) || "pending";
  const grade = asNumberOrNull(data.grade);
  return {
    id,
    classId: asTrimmedString(data.classId),
    classDocId: asTrimmedString(data.classDocId) || undefined,
    courseId: asTrimmedString(data.courseId) || undefined,
    lessonId: asTrimmedString(data.lessonId) || undefined,
    className: asTrimmedString(data.className),
    classType: asTrimmedString(data.classType),
    studentId: asTrimmedString(data.studentId),
    studentName: asTrimmedString(data.studentName),
    submittedAt: asTimestampOrNull(data.submittedAt),
    status,
    ...(grade !== null ? { grade } : {}),
    answers: Array.isArray(data.answers) ? (data.answers as Array<Record<string, unknown>>) : undefined,
    gradedAt: asTimestampOrNull(data.gradedAt),
  };
}

async function loadSubmissions(
  db: admin.firestore.Firestore,
  groupId: string,
  courseId: string,
  tasks: Task[],
): Promise<Submission[]> {
  const classIds = new Set(tasks.map((task) => task.id));
  const submissionsSnap = await db.collection("groups").doc(groupId).collection("submissions").get();
  const submissions = submissionsSnap.docs
    .map((docSnap) => toSubmission(docSnap.id, docSnap.data() as FirestoreRecord))
    .filter((submission) => {
      const submissionCourseId = asTrimmedString(submission.courseId);
      const classId = asTrimmedString(submission.classDocId ?? submission.classId);
      return submissionCourseId === courseId && classIds.has(classId);
    });

  const forumTasks = tasks.filter((task) => task.classType === "forum");
  const forumSubmissionGroups = await Promise.all(
    forumTasks.map(async (task) => {
      const forumSnap = await db
        .collection("courses")
        .doc(courseId)
        .collection("lessons")
        .doc(task.lessonId)
        .collection("classes")
        .doc(task.id)
        .collection("forums")
        .get();
      return forumSnap.docs
        .map((docSnap): Submission | null => {
          const data = docSnap.data() as FirestoreRecord;
          const authorId = asTrimmedString(data.authorId) || docSnap.id;
          if (!authorId) return null;
          const grade = asNumberOrNull(data.grade);
          return {
            id: docSnap.id,
            classId: task.id,
            classDocId: task.id,
            courseId,
            lessonId: task.lessonId,
            className: task.title,
            classType: "forum",
            studentId: authorId,
            studentName: asTrimmedString(data.authorName),
            submittedAt: asTimestampOrNull(data.createdAt),
            status: asTrimmedString(data.status) || (grade !== null ? "graded" : "pending"),
            ...(grade !== null ? { grade } : {}),
            gradedAt: asTimestampOrNull(data.gradedAt),
          } satisfies Submission;
        })
        .filter((item): item is Submission => item !== null);
    }),
  );

  return [...submissions, ...forumSubmissionGroups.flat()];
}

function submissionTimestamp(submission: Submission): number {
  return submission.submittedAt?.toMillis() ?? submission.gradedAt?.toMillis() ?? 0;
}

function shouldPreferIncomingSubmission(current: Submission, incoming: Submission): boolean {
  const currentTs = submissionTimestamp(current);
  const incomingTs = submissionTimestamp(incoming);
  if (incomingTs !== currentTs) return incomingTs > currentTs;
  const currentHasGrade = typeof current.grade === "number" && Number.isFinite(current.grade);
  const incomingHasGrade = typeof incoming.grade === "number" && Number.isFinite(incoming.grade);
  if (incomingHasGrade !== currentHasGrade) return incomingHasGrade;
  return incoming.id > current.id;
}

function normalizeTaskGrade(
  task: Task,
  submission: Submission | undefined,
  quizConfigByClass: Record<string, QuizClassConfig>,
): number | null {
  if (!submission) return null;
  const rawGrade = typeof submission.grade === "number" && Number.isFinite(submission.grade)
    ? submission.grade
    : null;
  if (task.classType !== "quiz") {
    return rawGrade === null ? null : roundGrade(rawGrade);
  }

  const quizConfig = quizConfigByClass[task.id];
  const answers = Array.isArray(submission.answers) ? submission.answers : [];
  if (quizConfig && answers.length > 0) {
    let matchedQuestions = 0;
    let earnedPoints = 0;
    answers.forEach((answer) => {
      const questionId = asTrimmedString(answer.questionId);
      if (!questionId) return;
      const questionConfig = quizConfig.questionsById[questionId];
      if (!questionConfig) return;
      matchedQuestions += 1;
      const selectedOptionId = asTrimmedString(answer.selectedOptionId);
      if (selectedOptionId && questionConfig.correctOptionIds.includes(selectedOptionId)) {
        earnedPoints += questionConfig.pointValue;
      }
    });
    if (matchedQuestions > 0) return roundGrade(earnedPoints);
  }

  if (rawGrade === null) return null;
  const quizPointsMaxFromAnswers = answers.length > 0
    ? Math.round(
        answers.reduce((sum, answer) => sum + normalizeQuizPointValue(answer.questionPointValue), 0) * 100,
      ) / 100
    : 0;
  const historicalQuizPointsMax = quizPointsMaxFromAnswers > 0 ? quizPointsMaxFromAnswers : answers.length;
  if (historicalQuizPointsMax <= 0) return roundGrade(rawGrade);
  const currentQuizPointsMax =
    quizConfig && quizConfig.totalPoints > 0 ? quizConfig.totalPoints : historicalQuizPointsMax;
  const looksLikeLegacyPercent =
    rawGrade <= 100 && (rawGrade > historicalQuizPointsMax || historicalQuizPointsMax > 100);
  const ratio = looksLikeLegacyPercent ? rawGrade / 100 : rawGrade / historicalQuizPointsMax;
  return Number.isFinite(ratio) ? roundGrade(ratio * currentQuizPointsMax) : roundGrade(rawGrade);
}

function calculateStudentCourse(params: {
  studentId: string;
  tasks: Task[];
  submissions: Submission[];
  quizConfigByClass: Record<string, QuizClassConfig>;
  previousClosure: FirestoreRecord;
}): StudentCourseCalculation {
  const latestByClass = new Map<string, Submission>();
  const classIdSet = new Set(params.tasks.map((task) => task.id));
  params.submissions.forEach((submission) => {
    if (submission.studentId !== params.studentId) return;
    const classId = asTrimmedString(submission.classDocId ?? submission.classId);
    if (!classId || !classIdSet.has(classId)) return;
    const current = latestByClass.get(classId);
    if (!current || shouldPreferIncomingSubmission(current, submission)) {
      latestByClass.set(classId, submission);
    }
  });

  const latestSubmissions = Array.from(latestByClass.values());
  const gradedCount = latestSubmissions.filter(
    (submission) => submission.status === "graded" || typeof submission.grade === "number",
  ).length;
  const grades = params.tasks
    .map((task) => normalizeTaskGrade(task, latestByClass.get(task.id), params.quizConfigByClass))
    .filter((grade): grade is number => typeof grade === "number" && Number.isFinite(grade));
  const autoGrade = grades.length > 0 ? roundGrade(grades.reduce((sum, grade) => sum + grade, 0)) : null;
  const pendingUngradedCount = Math.max(params.tasks.length - gradedCount, 0);

  const campusTasksGrade = asNumberOrNull(params.previousClosure.campusTasksGrade);
  const campusFinalExamGrade = asNumberOrNull(params.previousClosure.campusFinalExamGrade);
  const globalExamGrade = asNumberOrNull(params.previousClosure.globalExamGrade);
  const extraordinaryExamGrade = asNumberOrNull(params.previousClosure.extraordinaryExamGrade);
  const previousExtraConcepts = Array.isArray(params.previousClosure.extraConcepts)
    ? params.previousClosure.extraConcepts
    : [];
  const extraPointsTotal =
    asNumberOrNull(params.previousClosure.extraPointsTotal) ??
    roundGrade(
      previousExtraConcepts.reduce((sum, item) => {
        const points = item && typeof item === "object" ? asNumberOrNull((item as FirestoreRecord).points) : null;
        return sum + (points ?? 0);
      }, 0),
    );

  const previousManualFinalGrade = asNumberOrNull(params.previousClosure.finalGrade);
  const manualOverride = params.previousClosure.manualOverride === true && previousManualFinalGrade !== null;
  const finalGrade = manualOverride
    ? previousManualFinalGrade
    : roundGrade(
        (autoGrade ?? 0) +
          (campusTasksGrade ?? 0) +
          (campusFinalExamGrade ?? 0) +
          (globalExamGrade ?? 0) +
          (extraordinaryExamGrade ?? 0) +
          extraPointsTotal,
      );

  return {
    autoGrade,
    pendingUngradedCount,
    gradedCount,
    totalEvaluable: params.tasks.length,
    finalGrade,
    manualOverride,
    extraConcepts: previousExtraConcepts,
    extraPointsTotal,
    campusTasksGrade,
    campusFinalExamGrade,
    globalExamGrade,
    extraordinaryExamGrade,
  };
}

async function processCourse(params: {
  db: admin.firestore.Firestore;
  groupDoc: admin.firestore.QueryDocumentSnapshot | admin.firestore.DocumentSnapshot;
  groupData: FirestoreRecord;
  course: CourseEntry;
  cutoff: admin.firestore.Timestamp;
  autoCloseDays: number;
  dryRun: boolean;
  forceEligible?: boolean;
  actor?: ClosureActor;
}): Promise<CourseProcessResult> {
  const { db, groupDoc, groupData, course, cutoff, autoCloseDays, dryRun } = params;
  const actor = params.actor ?? {
    closedByType: "system",
    closureTrigger: "automatic",
    closedById: SYSTEM_CLOSER_ID,
    closedByName: SYSTEM_CLOSER_NAME,
  };
  const groupId = groupDoc.id;
  const groupName = asTrimmedString(groupData.groupName) || "Grupo";
  const enabledAtIso = course.enabledAt?.toDate().toISOString() ?? "";
  const eligible = Boolean(
    course.enabledAt &&
      (params.forceEligible === true || course.enabledAt.toMillis() <= cutoff.toMillis()),
  );
  const baseResult: CourseProcessResult = {
    groupId,
    groupName,
    courseId: course.courseId,
    courseName: course.courseName || "Materia",
    enabledAt: enabledAtIso,
    eligible,
    dryRun,
    closedCount: 0,
    alreadyClosedCount: 0,
    skippedInvalidGradeCount: 0,
    openCount: 0,
  };

  if (!baseResult.eligible) return baseResult;

  const [enrollmentsSnap, tasks] = await Promise.all([
    db.collection("studentEnrollments").where("groupId", "==", groupId).get(),
    loadCourseTasks(db, course.courseId),
  ]);
  const [submissions, quizConfigByClass] = await Promise.all([
    loadSubmissions(db, groupId, course.courseId, tasks),
    loadQuizConfigByClass(db, course.courseId, tasks),
  ]);

  const now = admin.firestore.Timestamp.now();
  const writes: Array<{
    ref: admin.firestore.DocumentReference;
    studentId: string;
    studentName: string;
    payload: FirestoreRecord;
  }> = [];

  enrollmentsSnap.docs.forEach((enrollmentDoc) => {
    const enrollmentData = enrollmentDoc.data() as FirestoreRecord;
    const status = asTrimmedString(enrollmentData.status) || "active";
    if (status === "archived" || status === "inactive" || status === "baja") return;
    const studentId = asTrimmedString(enrollmentData.studentId);
    if (!studentId) return;
    const studentName = asTrimmedString(enrollmentData.studentName) || "Alumno";
    const courseClosures = asObject(enrollmentData.courseClosures);
    const previousClosure = asObject(courseClosures[course.courseId]);
    if (previousClosure.status === "closed") {
      baseResult.alreadyClosedCount += 1;
      return;
    }

    baseResult.openCount += 1;
    const calculation = calculateStudentCourse({
      studentId,
      tasks,
      submissions,
      quizConfigByClass,
      previousClosure,
    });
    if (
      calculation.finalGrade === null ||
      !Number.isFinite(calculation.finalGrade) ||
      calculation.finalGrade < 0 ||
      calculation.finalGrade > 100
    ) {
      baseResult.skippedInvalidGradeCount += 1;
      return;
    }

    writes.push({
      ref: enrollmentDoc.ref,
      studentId,
      studentName,
      payload: {
        ...previousClosure,
        status: "closed",
        courseName: course.courseName || asTrimmedString(previousClosure.courseName) || "Materia",
        finalGrade: calculation.finalGrade,
        autoGrade: calculation.autoGrade,
        campusTasksGrade: calculation.campusTasksGrade,
        campusFinalExamGrade: calculation.campusFinalExamGrade,
        globalExamGrade: calculation.globalExamGrade,
        extraordinaryExamGrade: calculation.extraordinaryExamGrade,
        extraConcepts: calculation.extraConcepts,
        extraPointsTotal: calculation.extraPointsTotal,
        manualOverride: calculation.manualOverride,
        pendingUngradedCount: calculation.pendingUngradedCount,
        totalEvaluable: calculation.totalEvaluable,
        closedByType: actor.closedByType,
        closureTrigger: actor.closureTrigger,
        autoCloseDays,
        courseEnabledAt: course.enabledAt,
        autoClosedAt: actor.closureTrigger === "automatic" ? now : null,
        closedAt: now,
        closedById: actor.closedById,
        closedByName: actor.closedByName,
        updatedAt: now,
      },
    });
  });

  if (dryRun || writes.length === 0) {
    baseResult.closedCount = writes.length;
    return baseResult;
  }

  for (let index = 0; index < writes.length; index += 400) {
    const chunk = writes.slice(index, index + 400);
    const batch = db.batch();
    chunk.forEach((write) => {
      batch.set(
        write.ref,
        {
          studentId: write.studentId,
          studentName: write.studentName,
          groupId,
          groupName,
          updatedAt: now,
          courseClosures: {
            [course.courseId]: write.payload,
          },
        },
        { merge: true },
      );
    });
    await batch.commit();
  }

  baseResult.closedCount = writes.length;
  return baseResult;
}

async function resolveAdminDisplayName(adminContext: AdminTeacherAccessContext): Promise<string> {
  const userSnap = await getAdminFirestore().collection("users").doc(adminContext.uid).get();
  const userData = (userSnap.data() ?? {}) as FirestoreRecord;
  return (
    asTrimmedString(userData.name) ||
    asTrimmedString(userData.displayName) ||
    asTrimmedString(adminContext.email) ||
    "AdminTeacher"
  );
}

async function listClosureReviewItems(request: NextRequest): Promise<NextResponse> {
  const access = await requireClosureReviewAccess(request);

  const db = getAdminFirestore();
  const autoCloseDays = resolveAutoCloseDays();
  const nowMs = Date.now();
  const groupsSnap = await db.collection("groups").where("status", "==", "active").get();
  const items: ClosureReviewItem[] = [];

  for (const groupDoc of groupsSnap.docs) {
    const groupData = (groupDoc.data() ?? {}) as FirestoreRecord;
    if (!canReviewGroup({ access, groupData })) continue;

    const courses = toGroupCourses(groupData);
    if (courses.length === 0) continue;

    const enrollmentsSnap = await db
      .collection("studentEnrollments")
      .where("groupId", "==", groupDoc.id)
      .get();

    const activeEnrollments = enrollmentsSnap.docs.filter((enrollmentDoc) => {
      const enrollmentData = enrollmentDoc.data() as FirestoreRecord;
      const status = asTrimmedString(enrollmentData.status) || "active";
      return status !== "archived" && status !== "inactive" && status !== "baja";
    });

    for (const course of courses) {
      if (!course.enabledAt) continue;
      let closedCount = 0;
      let openCount = 0;
      activeEnrollments.forEach((enrollmentDoc) => {
        const enrollmentData = enrollmentDoc.data() as FirestoreRecord;
        const closures = asObject(enrollmentData.courseClosures);
        const previousClosure = asObject(closures[course.courseId]);
        if (previousClosure.status === "closed") {
          closedCount += 1;
          return;
        }
        openCount += 1;
      });

      if (openCount <= 0) continue;

      const daysSinceEnabled = daysBetween(course.enabledAt, nowMs);
      const daysUntilDue = REVIEW_DUE_DAYS - daysSinceEnabled;
      const estimatedCloseAt = admin.firestore.Timestamp.fromMillis(
        course.enabledAt.toMillis() + REVIEW_DUE_DAYS * 24 * 60 * 60 * 1000,
      );
      items.push({
        groupId: groupDoc.id,
        groupName: asTrimmedString(groupData.groupName) || "Grupo",
        courseId: course.courseId,
        courseName: course.courseName || "Materia",
        teacherId: asTrimmedString(groupData.teacherId),
        teacherName: asTrimmedString(groupData.teacherName) || "Sin profesor",
        enabledAt: course.enabledAt.toDate().toISOString(),
        estimatedCloseAt: estimatedCloseAt.toDate().toISOString(),
        daysSinceEnabled,
        weeksSinceEnabled: Math.floor(daysSinceEnabled / 7),
        daysUntilDue,
        due: daysUntilDue <= 0,
        reviewReady: daysSinceEnabled >= REVIEW_START_DAYS,
        closedCount,
        openCount,
        totalCount: closedCount + openCount,
      });
    }
  }

  items.sort((left, right) => {
    if (left.due !== right.due) return Number(right.due) - Number(left.due);
    if (left.reviewReady !== right.reviewReady) return Number(right.reviewReady) - Number(left.reviewReady);
    if (left.daysUntilDue !== right.daysUntilDue) return left.daysUntilDue - right.daysUntilDue;
    return left.groupName.localeCompare(right.groupName, "es-MX", { sensitivity: "base" });
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        autoCloseDays,
        reviewStartDays: REVIEW_START_DAYS,
        dueDays: REVIEW_DUE_DAYS,
        canClose: access.canClose,
        scopeRole: access.role,
        items,
      },
    },
    { status: 200 },
  );
}

async function closeCourseFromReview(request: NextRequest): Promise<NextResponse> {
  const adminContext = await requireAdminTeacherAccess(request);
  const body = (await request.json().catch(() => ({}))) as ManualCloseBody;
  const groupId = asTrimmedString(body.groupId);
  const courseId = asTrimmedString(body.courseId);
  if (!groupId || !courseId) {
    throw new RouteAccessError(400, "groupId y courseId son requeridos");
  }

  const db = getAdminFirestore();
  const groupSnap = await db.collection("groups").doc(groupId).get();
  if (!groupSnap.exists) {
    throw new RouteAccessError(404, "Grupo no encontrado");
  }

  const groupData = (groupSnap.data() ?? {}) as FirestoreRecord;
  const course = toGroupCourses(groupData).find((item) => item.courseId === courseId);
  if (!course) {
    throw new RouteAccessError(404, "Materia no encontrada en el grupo");
  }

  const autoCloseDays = resolveAutoCloseDays();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - autoCloseDays * 24 * 60 * 60 * 1000);
  const adminName = await resolveAdminDisplayName(adminContext);
  const result = await processCourse({
    db,
    groupDoc: groupSnap,
    groupData,
    course,
    cutoff,
    autoCloseDays,
    dryRun: false,
    forceEligible: true,
    actor: {
      closedByType: "teacher",
      closureTrigger: "manual",
      closedById: adminContext.uid,
      closedByName: adminName,
    },
  });

  return NextResponse.json(
    {
      success: true,
      data: {
        result,
        closedById: adminContext.uid,
        closedByName: adminName,
      },
    },
    { status: 200 },
  );
}

async function runAutoClosures(request: NextRequest): Promise<NextResponse> {
  assertCronAccess(request);

  const db = getAdminFirestore();
  const autoCloseDays = resolveAutoCloseDays();
  const nowMs = Date.now();
  const cutoff = admin.firestore.Timestamp.fromMillis(nowMs - autoCloseDays * 24 * 60 * 60 * 1000);
  const searchParams = request.nextUrl.searchParams;
  const dryRun = searchParams.get("dryRun") === "true" || searchParams.get("dryRun") === "1";
  const groupIdFilter = asTrimmedString(searchParams.get("groupId"));
  const courseIdFilter = asTrimmedString(searchParams.get("courseId"));

  const groupDocs = groupIdFilter
    ? await db.collection("groups").doc(groupIdFilter).get().then((docSnap) => (docSnap.exists ? [docSnap] : []))
    : await db
        .collection("groups")
        .where("status", "==", "active")
        .get()
        .then((snap) => snap.docs);

  const results: CourseProcessResult[] = [];
  for (const groupDoc of groupDocs) {
    const groupData = (groupDoc.data() ?? {}) as FirestoreRecord;
    const courses = toGroupCourses(groupData).filter((course) =>
      courseIdFilter ? course.courseId === courseIdFilter : true,
    );
    for (const course of courses) {
      if (!course.enabledAt) continue;
      results.push(
        await processCourse({
          db,
          groupDoc,
          groupData,
          course,
          cutoff,
          autoCloseDays,
          dryRun,
        }),
      );
    }
  }

  return NextResponse.json({
    success: true,
    dryRun,
    autoCloseDays,
    cutoff: cutoff.toDate().toISOString(),
    scannedGroups: groupDocs.length,
    scannedCourses: results.length,
    closedCount: results.reduce((sum, result) => sum + result.closedCount, 0),
    alreadyClosedCount: results.reduce((sum, result) => sum + result.alreadyClosedCount, 0),
    skippedInvalidGradeCount: results.reduce((sum, result) => sum + result.skippedInvalidGradeCount, 0),
    results,
  });
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  if (error instanceof TeacherAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("Error en cierre automatico de materias:", error);
  return NextResponse.json(
    { success: false, error: "No se pudo ejecutar el cierre automatico de materias" },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.get("review") === "true") {
      return await listClosureReviewItems(request);
    }
    return await runAutoClosures(request);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.clone().json().catch(() => null)) as ManualCloseBody | null;
    if (asTrimmedString(body?.action) === "closeCourse") {
      return await closeCourseFromReview(request);
    }
    return await runAutoClosures(request);
  } catch (error) {
    return toErrorResponse(error);
  }
}
