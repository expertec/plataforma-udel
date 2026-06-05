import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

type SubmissionPayload = {
  id: string;
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
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "teacher" ||
    value === "coordinadorPlantel" ||
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

async function resolveAccessContext(request: NextRequest, groupId: string) {
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

  const groupSnap = await getAdminFirestore().collection("groups").doc(groupId).get();
  if (!groupSnap.exists) {
    throw new RouteAccessError(404, "Grupo no encontrado");
  }

  const groupData = (groupSnap.data() ?? {}) as Record<string, unknown>;
  const plantelIds = getUserPlantelIds(userData);
  const groupPlantelId = asTrimmedString(groupData.plantelId);
  const coordinatorId = asTrimmedString(groupData.coordinatorId);
  const teacherId = asTrimmedString(groupData.teacherId);
  const assistantTeacherIds = asUniqueStringArray(groupData.assistantTeacherIds);
  const isOnlineGroup = !(typeof groupData.isInPerson === "boolean" && groupData.isInPerson === true);

  const canRead =
    role === "adminTeacher" ||
    role === "superAdminTeacher" ||
    (role === "teacher" && (teacherId === uid || assistantTeacherIds.includes(uid))) ||
    ((role === "coordinadorPlantel" || role === "director") &&
      ((groupPlantelId.length > 0 && plantelIds.includes(groupPlantelId)) ||
        (isOnlineGroup && coordinatorId === uid)));

  if (!canRead) {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json({ success: false, error: error.message }, { status: error.status });
  }

  console.error("Error al obtener submissions del grupo:", error);
  return NextResponse.json({ success: false, error: "Error interno del servidor" }, { status: 500 });
}

export async function GET(request: NextRequest, context: { params?: { groupId?: string } | Promise<{ groupId?: string }> }) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const groupIdFromParams = resolvedParams?.groupId?.trim() ?? "";
    const pathnameSegments = new URL(request.url).pathname.split("/").filter(Boolean);
    const groupIdFromPath =
      pathnameSegments[1] === "groups" && pathnameSegments[3] === "submissions"
        ? pathnameSegments[2]?.trim() ?? ""
        : "";
    const groupId = groupIdFromParams || groupIdFromPath;
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }

    await resolveAccessContext(request, groupId);

    const submissionsSnap = await getAdminFirestore()
      .collection("groups")
      .doc(groupId)
      .collection("submissions")
      .orderBy("submittedAt", "desc")
      .get();

    const submissions: SubmissionPayload[] = submissionsSnap.docs.map((docSnap) => {
      const data = docSnap.data() as Record<string, unknown>;
      return {
        id: docSnap.id,
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
