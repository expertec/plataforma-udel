import { NextRequest, NextResponse } from "next/server";
import {
  reactivateStudentAccount,
  StudentArchiveError,
} from "@/lib/server/student-archive";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReactivateStudentRequest = {
  studentId?: string;
};

type ReactivateAllowedRole = "adminTeacher" | "superAdminTeacher" | "coordinadorPlantel" | "director";

type ReactivateAccessContext = {
  uid: string;
  role: ReactivateAllowedRole;
  plantelIds: string[];
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

function asUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.trim().length > 0),
    ),
  );
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asAllowedRole(value: unknown): ReactivateAllowedRole | null {
  if (
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel" ||
    value === "director"
  ) {
    return value;
  }
  return null;
}

function getUserPlantelIds(data: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(data.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(data.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

function isGlobalReactivateRole(role: ReactivateAllowedRole): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

async function resolveReactivateAccess(request: NextRequest): Promise<ReactivateAccessContext> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(bearerToken);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const userSnap = await getAdminFirestore().collection("users").doc(decodedToken.uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asAllowedRole(userData.role) ?? asAllowedRole(decodedToken.role);
  if (!role) {
    throw new RouteAccessError(
      403,
      "Acceso restringido a adminTeacher, coordinador o director",
    );
  }

  return {
    uid: decodedToken.uid,
    role,
    plantelIds: getUserPlantelIds(userData),
  };
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError || error instanceof StudentArchiveError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error reactivando alumno", error);
  const message =
    process.env.NODE_ENV !== "production" && error instanceof Error
      ? error.message.trim() || "Error interno del servidor"
      : "Error interno del servidor";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const accessContext = await resolveReactivateAccess(request);
    const body = (await request.json().catch(() => ({}))) as ReactivateStudentRequest;
    const studentId = asTrimmedString(body.studentId);

    if (!studentId) {
      return NextResponse.json(
        { success: false, error: "studentId es requerido" },
        { status: 400 },
      );
    }

    const result = await reactivateStudentAccount({
      uid: studentId,
      reactivatedBy: accessContext.uid,
      allowedPlantelIds: isGlobalReactivateRole(accessContext.role)
        ? undefined
        : accessContext.plantelIds,
    });

    return NextResponse.json({ success: true, data: result }, { status: 200 });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
