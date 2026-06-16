import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

type GroupInfo = {
  id: string;
  groupName: string;
  courseNameMap: Map<string, string>;
};

type SubmissionPayload = {
  id: string;
  groupId: string;
  groupName: string;
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  className: string;
  classType: string;
  studentId: string;
  studentName: string;
  submittedAtMs?: number;
  fileUrl?: string;
  audioUrl?: string;
  content?: string;
  status: string;
  grade?: number;
  feedback?: string;
  gradedAtMs?: number;
  gradedById?: string;
  gradedByName?: string;
};

type RouteContext = {
  uid: string;
  role: AllowedRole;
  plantelIds: string[];
};

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  );
}

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "coordinadorPlantel" ||
    value === "director" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
    ? value
    : null;
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function toMillis(value: unknown): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        return (value as { toMillis: () => number }).toMillis();
      } catch {
        return undefined;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate().getTime();
      } catch {
        return undefined;
      }
    }
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      return Math.trunc(seconds * 1000 + nanos / 1_000_000);
    }
  }
  return undefined;
}

function toGroupInfo(
  id: string,
  data: Record<string, unknown>,
): GroupInfo {
  const courseNameMap = new Map<string, string>();
  const courses = Array.isArray(data.courses) ? data.courses : [];
  courses.forEach((course) => {
    if (!course || typeof course !== "object") return;
    const courseId = asTrimmedString((course as { courseId?: unknown }).courseId);
    if (!courseId) return;
    courseNameMap.set(
      courseId,
      asTrimmedString((course as { courseName?: unknown }).courseName),
    );
  });

  const primaryCourseId = asTrimmedString(data.courseId);
  if (primaryCourseId) {
    courseNameMap.set(primaryCourseId, asTrimmedString(data.courseName));
  }

  return {
    id,
    groupName: asTrimmedString(data.groupName) || "Sin nombre",
    courseNameMap,
  };
}

async function resolveRouteContext(request: NextRequest): Promise<RouteContext> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asAllowedRole(userData.role) ?? asAllowedRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }

  return {
    uid,
    role,
    plantelIds: getUserPlantelIds(userData),
  };
}

async function getCoordinatorScopeGroups(uid: string, plantelIds: string[]): Promise<Map<string, GroupInfo>> {
  const db = getAdminFirestore();
  const [plantelGroupSnaps, assignedGroupSnap] = await Promise.all([
    Promise.all(
      plantelIds.map((plantelId) =>
        db.collection("groups").where("plantelId", "==", plantelId).get(),
      ),
    ),
    db.collection("groups").where("coordinatorId", "==", uid).get(),
  ]);

  const groupsMap = new Map<string, GroupInfo>();

  plantelGroupSnaps.forEach((snap) => {
    snap.docs.forEach((docSnap) => {
      groupsMap.set(docSnap.id, toGroupInfo(docSnap.id, docSnap.data() as Record<string, unknown>));
    });
  });

  assignedGroupSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    if (data.isInPerson === true) return;
    groupsMap.set(docSnap.id, toGroupInfo(docSnap.id, data));
  });

  return groupsMap;
}

async function getStudentEnrollmentGroupIds(studentId: string): Promise<string[]> {
  if (!studentId) return [];
  const snap = await getAdminFirestore()
    .collection("studentEnrollments")
    .where("studentId", "==", studentId)
    .get();

  return Array.from(
    new Set(
      snap.docs
        .map((docSnap) => asTrimmedString((docSnap.data() as Record<string, unknown>).groupId))
        .filter(Boolean),
    ),
  );
}

async function getGroupsByIds(groupIds: string[]): Promise<Map<string, GroupInfo>> {
  const normalizedGroupIds = Array.from(
    new Set(groupIds.map((groupId) => groupId.trim()).filter(Boolean)),
  );
  const groupsMap = new Map<string, GroupInfo>();
  if (normalizedGroupIds.length === 0) return groupsMap;

  const db = getAdminFirestore();
  for (let i = 0; i < normalizedGroupIds.length; i += 30) {
    const batch = normalizedGroupIds.slice(i, i + 30);
    const snap = await db.collection("groups").where("__name__", "in", batch).get();
    snap.docs.forEach((docSnap) => {
      groupsMap.set(docSnap.id, toGroupInfo(docSnap.id, docSnap.data() as Record<string, unknown>));
    });
  }
  return groupsMap;
}

function mapSubmissionDoc(
  docSnap: FirebaseFirestore.QueryDocumentSnapshot,
  groupId: string,
  groupInfo?: GroupInfo,
): SubmissionPayload {
  const data = docSnap.data() as Record<string, unknown>;
  return {
    id: docSnap.id,
    groupId,
    groupName: groupInfo?.groupName ?? "Sin nombre",
    classId: asTrimmedString(data.classId),
    classDocId: asTrimmedString(data.classDocId) || undefined,
    courseId: asTrimmedString(data.courseId) || undefined,
    courseTitle: asTrimmedString(data.courseTitle) || undefined,
    lessonId: asTrimmedString(data.lessonId) || undefined,
    lessonTitle: asTrimmedString(data.lessonTitle) || undefined,
    className: asTrimmedString(data.className),
    classType: asTrimmedString(data.classType),
    studentId: asTrimmedString(data.studentId),
    studentName: asTrimmedString(data.studentName),
    submittedAtMs: toMillis(data.submittedAt),
    fileUrl: asTrimmedString(data.fileUrl) || undefined,
    audioUrl: asTrimmedString(data.audioUrl) || undefined,
    content: asTrimmedString(data.content) || undefined,
    status: asTrimmedString(data.status) || "pending",
    grade: typeof data.grade === "number" && Number.isFinite(data.grade) ? data.grade : undefined,
    feedback: asTrimmedString(data.feedback) || undefined,
    gradedAtMs: toMillis(data.gradedAt),
    gradedById: asTrimmedString(data.gradedById) || undefined,
    gradedByName: asTrimmedString(data.gradedByName) || undefined,
  };
}

async function getForumSubmissions(
  studentId: string,
  groupsMap: Map<string, GroupInfo>,
): Promise<SubmissionPayload[]> {
  if (!studentId || groupsMap.size === 0) return [];

  const forumsSnap = await getAdminFirestore()
    .collectionGroup("forums")
    .where("authorId", "==", studentId)
    .get();

  const results: SubmissionPayload[] = [];
  const seenPaths = new Set<string>();

  forumsSnap.docs.forEach((forumDoc) => {
    if (seenPaths.has(forumDoc.ref.path)) return;
    seenPaths.add(forumDoc.ref.path);

    const pathParts = forumDoc.ref.path.split("/");
    const courseId = pathParts[1] ?? "";
    const lessonId = pathParts[3] ?? "";
    const classId = pathParts[5] ?? "";
    if (!courseId) return;

    let resolvedGroupId = "";
    let resolvedGroupInfo: GroupInfo | undefined;
    for (const [groupId, groupInfo] of groupsMap.entries()) {
      if (!groupInfo.courseNameMap.has(courseId)) continue;
      resolvedGroupId = groupId;
      resolvedGroupInfo = groupInfo;
      break;
    }
    if (!resolvedGroupId || !resolvedGroupInfo) return;

    const forumData = forumDoc.data() as Record<string, unknown>;
    results.push({
      id: `forum-${courseId}-${lessonId}-${classId}-${forumDoc.id}`,
      groupId: resolvedGroupId,
      groupName: resolvedGroupInfo.groupName,
      classId,
      classDocId: classId || undefined,
      courseId,
      courseTitle: resolvedGroupInfo.courseNameMap.get(courseId) ?? undefined,
      lessonId: lessonId || undefined,
      className: asTrimmedString(forumData.classTitle) || "Foro",
      classType: "forum",
      studentId: asTrimmedString(forumData.authorId),
      studentName: asTrimmedString(forumData.authorName),
      submittedAtMs: toMillis(forumData.createdAt),
      fileUrl: asTrimmedString(forumData.mediaUrl) || undefined,
      audioUrl: undefined,
      content: asTrimmedString(forumData.text) || undefined,
      status:
        asTrimmedString(forumData.status) === "graded" ||
        (typeof forumData.grade === "number" && Number.isFinite(forumData.grade))
          ? "graded"
          : "pending",
      grade:
        typeof forumData.grade === "number" && Number.isFinite(forumData.grade)
          ? forumData.grade
          : undefined,
      feedback: asTrimmedString(forumData.feedback) || undefined,
      gradedAtMs: toMillis(forumData.gradedAt),
      gradedById: asTrimmedString(forumData.gradedById) || undefined,
      gradedByName: asTrimmedString(forumData.gradedByName) || undefined,
    });
  });

  return results;
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }

  console.error("Error al obtener el historial de entregas del alumno:", error);
  const message = error instanceof Error ? error.message : "Error interno del servidor";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function GET(
  request: NextRequest,
  context: { params?: { studentId?: string } | Promise<{ studentId?: string }> },
) {
  try {
    const access = await resolveRouteContext(request);
    const resolvedParams = await Promise.resolve(context.params);
    const studentId = resolvedParams?.studentId?.trim() ?? "";
    if (!studentId) {
      throw new RouteAccessError(400, "studentId es requerido");
    }

    const db = getAdminFirestore();
    const allSubmissions: SubmissionPayload[] = [];
    let groupsMap = new Map<string, GroupInfo>();

    if (access.role === "adminTeacher" || access.role === "superAdminTeacher") {
      const [submissionsSnap, enrolledGroupIds] = await Promise.all([
        db.collectionGroup("submissions").where("studentId", "==", studentId).get(),
        getStudentEnrollmentGroupIds(studentId),
      ]);

      const submissionGroupIds = submissionsSnap.docs
        .map((docSnap) => {
          const pathParts = docSnap.ref.path.split("/");
          return pathParts[0] === "groups" ? pathParts[1] ?? "" : "";
        })
        .filter(Boolean);

      groupsMap = await getGroupsByIds([...submissionGroupIds, ...enrolledGroupIds]);

      submissionsSnap.docs.forEach((docSnap) => {
        const pathParts = docSnap.ref.path.split("/");
        const groupId = pathParts[1] ?? "";
        if (!groupId) return;
        allSubmissions.push(mapSubmissionDoc(docSnap, groupId, groupsMap.get(groupId)));
      });
    } else {
      const scopeGroupsMap = await getCoordinatorScopeGroups(access.uid, access.plantelIds);
      if (scopeGroupsMap.size === 0) {
        return NextResponse.json({ success: true, data: { submissions: [] } }, { status: 200 });
      }

      const enrolledGroupIds = await getStudentEnrollmentGroupIds(studentId);
      const scopedEnrollmentGroupIds = enrolledGroupIds.filter((groupId) => scopeGroupsMap.has(groupId));
      const groupIdsToScan = scopedEnrollmentGroupIds.length > 0
        ? scopedEnrollmentGroupIds
        : Array.from(scopeGroupsMap.keys());

      groupsMap = scopeGroupsMap;

      await Promise.all(
        groupIdsToScan.map(async (groupId) => {
          const submissionsSnap = await db
            .collection("groups")
            .doc(groupId)
            .collection("submissions")
            .where("studentId", "==", studentId)
            .get();

          submissionsSnap.docs.forEach((docSnap) => {
            allSubmissions.push(mapSubmissionDoc(docSnap, groupId, groupsMap.get(groupId)));
          });
        }),
      );
    }

    const forumSubmissions = await getForumSubmissions(studentId, groupsMap);
    const submissions = [...allSubmissions, ...forumSubmissions].sort((left, right) => {
      const leftTs = left.submittedAtMs ?? 0;
      const rightTs = right.submittedAtMs ?? 0;
      return rightTs - leftTs;
    });

    return NextResponse.json(
      {
        success: true,
        data: { submissions },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
