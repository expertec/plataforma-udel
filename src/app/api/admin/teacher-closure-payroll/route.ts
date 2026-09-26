import { NextRequest, NextResponse } from "next/server";
import * as admin from "firebase-admin";
import { getAdminFirestore } from "@/lib/firebase/admin";
import {
  requireTeacherAccess,
  TeacherAccessError,
  type TeacherAccessContext,
} from "@/lib/server/require-teacher-access";
import { isStudentStatusActive } from "@/lib/students/status";
import { normalizeTeacherPayrollDeposit } from "@/lib/teachers/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FirestoreRecord = Record<string, unknown>;

type CourseEntry = {
  courseId: string;
  courseName: string;
  program: string;
};

type AssistantTeacher = {
  id: string;
  name: string;
  email: string;
};

type TeacherSnapshot = {
  id: string;
  name: string;
  email: string;
  payrollDeposit: ReturnType<typeof normalizeTeacherPayrollDeposit>;
};

type PayrollStatus = "payable" | "pending" | "review" | "paid";

type PayrollItem = {
  sourceKey: string;
  status: PayrollStatus;
  reasons: string[];
  paymentNotes: string[];
  groupId: string;
  groupName: string;
  groupStatus: string;
  plantelId: string;
  plantelName: string;
  courseId: string;
  courseName: string;
  program: string;
  level: "preparatoria" | "licenciatura" | "otros" | "sinPrograma";
  payeeId: string;
  payeeName: string;
  payeeEmail: string;
  payeeRole: "primaryTeacher" | "mentor" | "multipleMentors" | "missing";
  payrollDeposit: ReturnType<typeof normalizeTeacherPayrollDeposit>;
  configuredPayrollAmount: number | null;
  closedInPeriodCount: number;
  totalClosedCount: number;
  openCount: number;
  totalStudents: number;
  firstClosedAt: string;
  lastClosedAt: string;
  closureDocumentUrl: string;
  closureDocumentFileName: string;
  closedByNames: string[];
  closureTriggers: string[];
};

type EnrollmentCourseClosure = {
  status: string;
  closedAt: admin.firestore.Timestamp | null;
  closedById: string;
  closedByName: string;
  closureTrigger: string;
  closureDocumentUrl: string;
  closureDocumentFileName: string;
};

type PayrollEnrollmentRecord = {
  docId: string;
  studentId: string;
  data: FirestoreRecord;
};

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

function parseDateBoundary(value: string | null, endOfDay: boolean): number | null {
  const raw = asTrimmedString(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).getTime();
}

function resolveClosureTimestamp(closure: FirestoreRecord): admin.firestore.Timestamp | null {
  return (
    asTimestampOrNull(closure.closedAt) ??
    asTimestampOrNull(closure.autoClosedAt) ??
    asTimestampOrNull(closure.updatedAt)
  );
}

function normalizeKeyword(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function inferProgramLevel(program: string): PayrollItem["level"] {
  const normalized = normalizeKeyword(program);
  if (!normalized) return "sinPrograma";
  if (["prepa", "preparatoria", "bachillerato", "media superior"].some((keyword) => normalized.includes(keyword))) {
    return "preparatoria";
  }
  if (["licenciatura", "lic ", "lic.", "ingenier", "tsu", "universitari"].some((keyword) => normalized.includes(keyword))) {
    return "licenciatura";
  }
  return "otros";
}

function getUserPlantelIds(data: FirestoreRecord): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function isAdminRole(role: TeacherAccessContext["role"]): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

function isScopedPayrollRole(role: TeacherAccessContext["role"]): boolean {
  return role === "coordinadorPlantel" || role === "director";
}

async function requirePayrollAccess(request: NextRequest): Promise<TeacherAccessContext & { plantelIds: string[] }> {
  const context = await requireTeacherAccess(request);
  if (!isAdminRole(context.role) && !isScopedPayrollRole(context.role)) {
    throw new RouteAccessError(403, "Acceso restringido a administradores, directores y coordinadores");
  }

  const userSnap = await getAdminFirestore().collection("users").doc(context.uid).get();
  const userData = (userSnap.data() ?? {}) as FirestoreRecord;
  return {
    ...context,
    plantelIds: getUserPlantelIds(userData),
  };
}

function canReviewGroup(params: {
  access: TeacherAccessContext & { plantelIds: string[] };
  groupData: FirestoreRecord;
}): boolean {
  const { access, groupData } = params;
  if (isAdminRole(access.role)) return true;

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
          program: asTrimmedString(course.program),
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
      program: asTrimmedString(data.program),
    },
  ];
}

function toAssistantTeachers(value: unknown): AssistantTeacher[] {
  if (!Array.isArray(value)) return [];
  return value.reduce<AssistantTeacher[]>((acc, teacher) => {
    if (!teacher || typeof teacher !== "object" || Array.isArray(teacher)) return acc;
    const raw = teacher as FirestoreRecord;
    const id = asTrimmedString(raw.id);
    if (!id) return acc;
    acc.push({
      id,
      name: asTrimmedString(raw.name),
      email: asTrimmedString(raw.email),
    });
    return acc;
  }, []);
}

function resolveCoursePayees(groupData: FirestoreRecord, courseId: string): {
  payeeIds: string[];
  payeeNames: string[];
  role: PayrollItem["payeeRole"];
} {
  const access = asObject(groupData.mentorCourseAccess);
  const assistantTeachers = toAssistantTeachers(groupData.assistantTeachers);
  const mentors = assistantTeachers.filter((teacher) =>
    asUniqueStringArray(access[teacher.id]).includes(courseId),
  );
  const mentorIds = mentors.map((teacher) => teacher.id);
  const mentorNames = mentors.map((teacher) => teacher.name || teacher.email || teacher.id);

  if (mentorIds.length === 1) return { payeeIds: mentorIds, payeeNames: mentorNames, role: "mentor" };
  if (mentorIds.length > 1) return { payeeIds: mentorIds, payeeNames: mentorNames, role: "multipleMentors" };

  const primaryTeacherId = asTrimmedString(groupData.teacherId);
  const primaryTeacherName = asTrimmedString(groupData.teacherName);
  return primaryTeacherId
    ? { payeeIds: [primaryTeacherId], payeeNames: [primaryTeacherName || primaryTeacherId], role: "primaryTeacher" }
    : { payeeIds: [], payeeNames: [], role: "missing" };
}

function resolveMentorCoursePayrollAmount(params: {
  groupData: FirestoreRecord;
  mentorId: string;
  courseId: string;
}): number | null {
  const { groupData, mentorId, courseId } = params;
  if (!mentorId || !courseId) return null;
  const amountsByMentor = asObject(groupData.mentorCoursePayrollAmounts);
  const amountsByCourse = asObject(amountsByMentor[mentorId]);
  const rawAmount = amountsByCourse[courseId];
  const amount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
}

function normalizeClosure(raw: unknown): EnrollmentCourseClosure | null {
  const closure = asObject(raw);
  const status = asTrimmedString(closure.status);
  if (status !== "closed") return null;
  const closedAt = resolveClosureTimestamp(closure);
  if (!closedAt) return null;
  return {
    status,
    closedAt,
    closedById: asTrimmedString(closure.closedById),
    closedByName: asTrimmedString(closure.closedByName),
    closureTrigger: asTrimmedString(closure.closureTrigger),
    closureDocumentUrl: asTrimmedString(closure.closureDocumentUrl),
    closureDocumentFileName: asTrimmedString(closure.closureDocumentFileName),
  };
}

function isSystemCloser(closure: EnrollmentCourseClosure): boolean {
  const id = normalizeKeyword(closure.closedById);
  const name = normalizeKeyword(closure.closedByName);
  return id === "system" || name === "sistema";
}

function getEnrollmentKey(docId: string, enrollmentData: FirestoreRecord): string {
  return asTrimmedString(enrollmentData.studentId) || docId;
}

function shouldCountEnrollment(enrollmentData: FirestoreRecord): boolean {
  const status = asTrimmedString(enrollmentData.status) || "active";
  return enrollmentData.archived !== true && isStudentStatusActive(status);
}

function getEnrollmentCourseIds(enrollmentData: FirestoreRecord): string[] {
  const ids = new Set<string>();
  const courseId = asTrimmedString(enrollmentData.courseId);
  if (courseId) ids.add(courseId);
  asUniqueStringArray(enrollmentData.courseIds).forEach((id) => ids.add(id));
  return Array.from(ids);
}

function isCourseOverrideEnrollment(enrollmentData: FirestoreRecord): boolean {
  const source = asTrimmedString(enrollmentData.source);
  return (
    enrollmentData.isCourseOverride === true ||
    enrollmentData.scope === "course" ||
    source === "courseOverride" ||
    source === "extraCourse"
  );
}

function enrollmentAppliesToCourse(enrollmentData: FirestoreRecord, courseId: string): boolean {
  if (asUniqueStringArray(enrollmentData.excludedCourseIds).includes(courseId)) return false;
  if (!isCourseOverrideEnrollment(enrollmentData)) return true;
  return getEnrollmentCourseIds(enrollmentData).includes(courseId);
}

function selectEnrollmentForCourse(params: {
  groupId: string;
  courseId: string;
  records: PayrollEnrollmentRecord[];
}): PayrollEnrollmentRecord | null {
  const applicableRecords = params.records.filter((record) =>
    enrollmentAppliesToCourse(record.data, params.courseId),
  );
  if (applicableRecords.length === 0) return null;

  const scoreRecord = (record: PayrollEnrollmentRecord): number => {
    const closures = asObject(record.data.courseClosures);
    const hasClosedClosure = normalizeClosure(closures[params.courseId]) !== null;
    const isCanonical = record.docId === `${params.groupId}_${record.studentId}`;
    const isOverride = isCourseOverrideEnrollment(record.data);
    return (hasClosedClosure ? 100 : 0) + (isCanonical ? 10 : 0) + (!isOverride ? 5 : 0);
  };

  return [...applicableRecords].sort((left, right) => scoreRecord(right) - scoreRecord(left))[0] ?? null;
}

async function loadTeachersById(db: admin.firestore.Firestore): Promise<Map<string, TeacherSnapshot>> {
  const usersSnap = await db.collection("users").get();
  const map = new Map<string, TeacherSnapshot>();
  usersSnap.docs.forEach((docSnap) => {
    const data = (docSnap.data() ?? {}) as FirestoreRecord;
    map.set(docSnap.id, {
      id: docSnap.id,
      name:
        asTrimmedString(data.displayName) ||
        asTrimmedString(data.name) ||
        asTrimmedString(data.email) ||
        "Profesor",
      email: asTrimmedString(data.email),
      payrollDeposit: normalizeTeacherPayrollDeposit(data.payrollDeposit),
    });
  });
  return map;
}

async function loadCourseMeta(params: {
  db: admin.firestore.Firestore;
  courseId: string;
  fallbackName: string;
  fallbackProgram: string;
}): Promise<{ courseName: string; program: string }> {
  try {
    const courseSnap = await params.db.collection("courses").doc(params.courseId).get();
    const data = (courseSnap.data() ?? {}) as FirestoreRecord;
    return {
      courseName:
        asTrimmedString(data.title) ||
        asTrimmedString(data.courseName) ||
        params.fallbackName ||
        "Materia",
      program:
        asTrimmedString(data.program) ||
        asTrimmedString(data.category) ||
        params.fallbackProgram ||
        "Sin programa",
    };
  } catch {
    return {
      courseName: params.fallbackName || "Materia",
      program: params.fallbackProgram || "Sin programa",
    };
  }
}

async function alreadyPaidForSourceKey(db: admin.firestore.Firestore, sourceKey: string): Promise<boolean> {
  const snap = await db
    .collection("teacherPayrollItems")
    .where("sourceKey", "==", sourceKey)
    .where("status", "in", ["approved", "paid"])
    .limit(1)
    .get()
    .catch(() => null);
  return Boolean(snap && !snap.empty);
}

async function listClosurePayrollItems(request: NextRequest): Promise<NextResponse> {
  const access = await requirePayrollAccess(request);
  const fromMs = parseDateBoundary(request.nextUrl.searchParams.get("from"), false);
  const toMs = parseDateBoundary(request.nextUrl.searchParams.get("to"), true);
  if (fromMs === null || toMs === null) {
    throw new RouteAccessError(400, "from y to son requeridos en formato YYYY-MM-DD");
  }
  if (fromMs > toMs) {
    throw new RouteAccessError(400, "El rango de fechas no es valido");
  }

  const db = getAdminFirestore();
  const [groupsSnap, teachersById] = await Promise.all([
    db.collection("groups").get(),
    loadTeachersById(db),
  ]);

  const items: PayrollItem[] = [];
  for (const groupDoc of groupsSnap.docs) {
    const groupData = (groupDoc.data() ?? {}) as FirestoreRecord;
    if (!canReviewGroup({ access, groupData })) continue;

    const courses = toGroupCourses(groupData);
    if (courses.length === 0) continue;

    const [groupStudentsSnap, liveEnrollmentsSnap] = await Promise.all([
      db.collection("groups").doc(groupDoc.id).collection("students").get(),
      db.collection("studentEnrollments").where("groupId", "==", groupDoc.id).get(),
    ]);

    const activeGroupStudentIds = new Set<string>();
    groupStudentsSnap.docs.forEach((docSnap) => {
      const data = (docSnap.data() ?? {}) as FirestoreRecord;
      if (isStudentStatusActive(data.status)) activeGroupStudentIds.add(docSnap.id);
    });
    const hasActiveGroupRoster = activeGroupStudentIds.size > 0;

    const enrollmentsByStudent = new Map<string, PayrollEnrollmentRecord[]>();
    liveEnrollmentsSnap.docs.forEach((docSnap) => {
      const data = (docSnap.data() ?? {}) as FirestoreRecord;
      if (!shouldCountEnrollment(data)) return;
      const studentId = getEnrollmentKey(docSnap.id, data);
      if (!studentId) return;
      if (hasActiveGroupRoster && !activeGroupStudentIds.has(studentId) && !isCourseOverrideEnrollment(data)) return;
      const records = enrollmentsByStudent.get(studentId) ?? [];
      records.push({ docId: docSnap.id, studentId, data });
      enrollmentsByStudent.set(studentId, records);
    });

    if (enrollmentsByStudent.size === 0) continue;

    for (const course of courses) {
      const closedClosures: EnrollmentCourseClosure[] = [];
      let totalClosedCount = 0;
      let totalStudents = 0;

      enrollmentsByStudent.forEach((records) => {
        const selectedEnrollment = selectEnrollmentForCourse({
          groupId: groupDoc.id,
          courseId: course.courseId,
          records,
        });
        if (!selectedEnrollment) return;
        const enrollmentData = selectedEnrollment.data;
        totalStudents += 1;
        const closures = asObject(enrollmentData.courseClosures);
        const closure = normalizeClosure(closures[course.courseId]);
        if (!closure) return;
        totalClosedCount += 1;
        const closedAtMs = closure.closedAt?.toMillis() ?? 0;
        if (closedAtMs >= fromMs && closedAtMs <= toMs) {
          closedClosures.push(closure);
        }
      });

      if (closedClosures.length === 0) continue;

      const openCount = Math.max(totalStudents - totalClosedCount, 0);
      const sourceKey = `${groupDoc.id}:${course.courseId}`;
      const paid = await alreadyPaidForSourceKey(db, sourceKey);
      const payees = resolveCoursePayees(groupData, course.courseId);
      const primaryTeacherId = asTrimmedString(groupData.teacherId);
      let payeeId = payees.payeeIds[0] ?? "";
      let payeeRole = payees.role;
      let payeeNames = payees.payeeNames;

      if (payees.role === "primaryTeacher") {
        const humanClosers = closedClosures.filter((closure) => !isSystemCloser(closure));
        const closerIds = Array.from(
          new Set(
            humanClosers
              .map((closure) => closure.closedById)
              .filter((closedById) => closedById && closedById !== primaryTeacherId),
          ),
        );
        const closerNames = Array.from(
          new Set(
            humanClosers
              .map((closure) => closure.closedByName)
              .filter((closedByName) => closedByName && normalizeKeyword(closedByName) !== normalizeKeyword(asTrimmedString(groupData.teacherName))),
          ),
        );

        if (closerIds.length === 1) {
          payeeId = closerIds[0];
          payeeRole = "mentor";
          payeeNames = [teachersById.get(payeeId)?.name || closerNames[0] || payeeId];
        } else if (closerIds.length > 1) {
          payeeId = "";
          payeeRole = "multipleMentors";
          payeeNames = closerIds.map((closerId) => teachersById.get(closerId)?.name || closerId);
        } else if (closerNames.length === 1) {
          payeeId = "";
          payeeRole = "mentor";
          payeeNames = [closerNames[0]];
        } else if (closerNames.length > 1) {
          payeeId = "";
          payeeRole = "multipleMentors";
          payeeNames = closerNames;
        }
      }

      const teacher = payeeId ? teachersById.get(payeeId) : undefined;
      const configuredPayrollAmount =
        payeeRole === "mentor"
          ? resolveMentorCoursePayrollAmount({
              groupData,
              mentorId: payeeId,
              courseId: course.courseId,
            })
          : null;
      const meta = await loadCourseMeta({
        db,
        courseId: course.courseId,
        fallbackName: course.courseName,
        fallbackProgram: course.program || asTrimmedString(groupData.program),
      });
      const reasons: string[] = [];
      const paymentNotes: string[] = [];
      const closureRatio = totalStudents > 0 ? totalClosedCount / totalStudents : 0;
      const hasMajorityClosureEvidence = openCount > 0 && closureRatio > 0.5;
      if (openCount > 0 && !hasMajorityClosureEvidence) {
        reasons.push(`${openCount} alumno(s) siguen abiertos`);
      }
      if (hasMajorityClosureEvidence) {
        paymentNotes.push(
          `${openCount} alumno(s) siguen abiertos, pago liberado por tener ${totalClosedCount}/${totalStudents} cerrados`,
        );
      }
      if (payeeRole === "multipleMentors") reasons.push("Hay mas de un mentor asignado a la materia");
      if (payeeRole === "missing") reasons.push("No hay docente responsable identificado");
      if (!payeeId && payeeRole === "mentor") reasons.push("Responsable identificado por cierre, falta vincular usuario");
      if (payeeId && !teacher) reasons.push("El docente responsable no existe en usuarios");
      if (
        teacher &&
        !teacher.payrollDeposit.clabe &&
        !teacher.payrollDeposit.bank &&
        !teacher.payrollDeposit.depositDetails
      ) {
        reasons.push("Sin datos de nomina registrados");
      }

      const status: PayrollStatus = paid
        ? "paid"
        : reasons.length > 0 && !(!hasMajorityClosureEvidence && openCount > 0)
          ? "review"
          : openCount > 0 && !hasMajorityClosureEvidence
            ? "pending"
            : "payable";
      const sortedClosedAt = closedClosures
        .map((closure) => closure.closedAt)
        .filter((value): value is admin.firestore.Timestamp => value !== null)
        .sort((left, right) => left.toMillis() - right.toMillis());
      const closureDocument = closedClosures.find((closure) => closure.closureDocumentUrl);

      items.push({
        sourceKey,
        status,
        reasons,
        paymentNotes,
        groupId: groupDoc.id,
        groupName: asTrimmedString(groupData.groupName) || "Grupo",
        groupStatus: asTrimmedString(groupData.status) || "active",
        plantelId: asTrimmedString(groupData.plantelId),
        plantelName: asTrimmedString(groupData.plantelName),
        courseId: course.courseId,
        courseName: meta.courseName,
        program: meta.program,
        level: inferProgramLevel(meta.program),
        payeeId,
        payeeName: teacher?.name || payeeNames.join(", ") || "Sin profesor",
        payeeEmail: teacher?.email || "",
        payeeRole,
        payrollDeposit: teacher?.payrollDeposit ?? normalizeTeacherPayrollDeposit(null),
        configuredPayrollAmount,
        closedInPeriodCount: closedClosures.length,
        totalClosedCount,
        openCount,
        totalStudents,
        firstClosedAt: sortedClosedAt[0]?.toDate().toISOString() ?? "",
        lastClosedAt: sortedClosedAt[sortedClosedAt.length - 1]?.toDate().toISOString() ?? "",
        closureDocumentUrl: closureDocument?.closureDocumentUrl ?? "",
        closureDocumentFileName: closureDocument?.closureDocumentFileName ?? "",
        closedByNames: Array.from(new Set(closedClosures.map((closure) => closure.closedByName).filter(Boolean))),
        closureTriggers: Array.from(new Set(closedClosures.map((closure) => closure.closureTrigger).filter(Boolean))),
      });
    }
  }

  items.sort((left, right) => {
    const statusOrder: Record<PayrollStatus, number> = { payable: 0, review: 1, pending: 2, paid: 3 };
    if (statusOrder[left.status] !== statusOrder[right.status]) {
      return statusOrder[left.status] - statusOrder[right.status];
    }
    const dateCompare = new Date(right.lastClosedAt).getTime() - new Date(left.lastClosedAt).getTime();
    if (dateCompare !== 0) return dateCompare;
    return left.payeeName.localeCompare(right.payeeName, "es-MX", { sensitivity: "base" });
  });

  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] += 1;
      return acc;
    },
    { total: 0, payable: 0, pending: 0, review: 0, paid: 0 },
  );

  return NextResponse.json({
    success: true,
    data: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      scopeRole: access.role,
      items,
      summary,
      rule:
        "Si una materia tiene un mentor asignado, el candidato de pago es ese mentor; sin mentor, el titular del grupo. Varios mentores requieren revision.",
    },
  });
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  if (error instanceof TeacherAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }
  console.error("Error generando nomina por cierres:", error);
  return NextResponse.json(
    { success: false, error: "No se pudo generar la nomina por cierres" },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    return await listClosurePayrollItems(request);
  } catch (error) {
    return toErrorResponse(error);
  }
}
