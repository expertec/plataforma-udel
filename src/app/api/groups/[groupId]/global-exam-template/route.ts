import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { toGlobalExamTemplateRecord } from "@/lib/server/global-exams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "teacher" | "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

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

function toMillis(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        const millis = (value as { toMillis: () => number }).toMillis();
        return Number.isFinite(millis) ? millis : 0;
      } catch {
        return 0;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const millis = (value as { toDate: () => Date }).toDate().getTime();
        return Number.isFinite(millis) ? millis : 0;
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

async function resolveAccess(request: NextRequest, groupId: string) {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token invalido o expirado");
  }

  const uid = decodedToken.uid;
  const db = getAdminFirestore();
  const userSnap = await db.collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asAllowedRole(userData.role) ?? asAllowedRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }

  const groupSnap = await db.collection("groups").doc(groupId).get();
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

  console.error("Error al obtener plantilla de examen global del grupo:", error);
  return NextResponse.json({ success: false, error: "Error interno del servidor" }, { status: 500 });
}

export async function GET(
  request: NextRequest,
  context: { params?: { groupId?: string } | Promise<{ groupId?: string }> },
) {
  try {
    const resolvedParams = await Promise.resolve(context.params);
    const groupIdFromParams = resolvedParams?.groupId?.trim() ?? "";
    const pathnameSegments = new URL(request.url).pathname.split("/").filter(Boolean);
    const groupIdFromPath =
      pathnameSegments[1] === "groups" && pathnameSegments[3] === "global-exam-template"
        ? pathnameSegments[2]?.trim() ?? ""
        : "";
    const groupId = groupIdFromParams || groupIdFromPath;
    if (!groupId) {
      throw new RouteAccessError(400, "groupId es requerido");
    }

    const courseId = new URL(request.url).searchParams.get("courseId")?.trim() ?? "";
    if (!courseId) {
      throw new RouteAccessError(400, "courseId es requerido");
    }

    await resolveAccess(request, groupId);

    const snap = await getAdminFirestore()
      .collection("globalExamTemplates")
      .where("courseId", "==", courseId)
      .get();
    const templates = snap.docs.sort((left, right) => {
      const leftStatusRank = left.data()?.status === "published" ? 1 : 0;
      const rightStatusRank = right.data()?.status === "published" ? 1 : 0;
      if (leftStatusRank !== rightStatusRank) return rightStatusRank - leftStatusRank;
      return toMillis(right.data()?.updatedAt) - toMillis(left.data()?.updatedAt);
    });

    if (templates.length === 0) {
      return NextResponse.json({ success: true, data: null });
    }

    const templateSnap = templates[0];
    return NextResponse.json({
      success: true,
      data: toGlobalExamTemplateRecord(templateSnap.id, templateSnap.data() ?? {}),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
