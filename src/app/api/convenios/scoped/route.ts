import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "adminTeacher" | "superAdminTeacher" | "director" | "coordinadorPlantel";

type AccessContext = {
  uid: string;
  role: AllowedRole;
  scope: "all" | "scoped";
  plantelIds: string[];
};

type AgreementPayload = {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentPhone?: string;
  reason: string;
  startDate: string;
  endDate: string;
  status: "active" | "cancelled";
  createdBy?: string;
  updatedBy?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  cancelledAtMs?: number;
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

function asAllowedRole(value: unknown): AllowedRole | null {
  return value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "director" ||
    value === "coordinadorPlantel"
    ? value
    : null;
}

function getPlantelIds(data: Record<string, unknown>): string[] {
  const explicit = asUniqueStringArray(data.plantelIds);
  if (explicit.length > 0) return explicit;
  const legacy = asTrimmedString(data.plantelId);
  return legacy ? [legacy] : [];
}

function normalizeExtraRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return asUniqueStringArray(value);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key, enabled]) => key.trim().length > 0 && enabled === true)
      .map(([key]) => key.trim());
  }
  return [];
}

function hasDirectorExtraRole(
  userData: Record<string, unknown>,
  decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>,
): boolean {
  if (userData.directorEnabled === true) return true;

  const extraRoles = new Set<string>([
    ...normalizeExtraRoles(userData.extraRoles),
    ...normalizeExtraRoles(decodedToken.extraRoles),
  ]);

  return extraRoles.has("director");
}

function toMillis(value: unknown): number | undefined {
  if (!value) return undefined;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    if (
      "toMillis" in value &&
      typeof (value as { toMillis?: unknown }).toMillis === "function"
    ) {
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

function toAgreementPayload(id: string, data: Record<string, unknown>): AgreementPayload {
  return {
    id,
    studentId: asTrimmedString(data.studentId),
    studentName: asTrimmedString(data.studentName),
    studentEmail: asTrimmedString(data.studentEmail),
    studentPhone: asTrimmedString(data.studentPhone) || undefined,
    reason: asTrimmedString(data.reason),
    startDate: asTrimmedString(data.startDate),
    endDate: asTrimmedString(data.endDate),
    status: data.status === "cancelled" ? "cancelled" : "active",
    createdBy: asTrimmedString(data.createdBy) || undefined,
    updatedBy: asTrimmedString(data.updatedBy) || undefined,
    createdAtMs: toMillis(data.createdAt),
    updatedAtMs: toMillis(data.updatedAt),
    cancelledAtMs: toMillis(data.cancelledAt),
  };
}

function hasAnyOverlap(scopeValues: string[], targetValues: string[]): boolean {
  if (scopeValues.length === 0 || targetValues.length === 0) return false;
  const scope = new Set(scopeValues);
  return targetValues.some((value) => scope.has(value));
}

async function resolveAccessContext(request: NextRequest): Promise<AccessContext> {
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

  if (role === "adminTeacher" || role === "superAdminTeacher") {
    return {
      uid,
      role,
      scope: "all",
      plantelIds: [],
    };
  }

  const plantelIds = getPlantelIds(userData);
  if (role === "director") {
    return {
      uid,
      role,
      scope: "scoped",
      plantelIds,
    };
  }

  if (role === "coordinadorPlantel" && hasDirectorExtraRole(userData, decodedToken)) {
    return {
      uid,
      role,
      scope: "scoped",
      plantelIds,
    };
  }

  throw new RouteAccessError(403, "Missing or insufficient permissions.");
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status },
    );
  }

  console.error("Error obteniendo convenios por alcance:", error);
  return NextResponse.json(
    {
      success: false,
      error: "Error interno del servidor",
    },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const context = await resolveAccessContext(request);
    const searchParams = request.nextUrl.searchParams;
    const parsedLimit = Number(searchParams.get("limit") ?? 300);
    const maxResults = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(Math.trunc(parsedLimit), 500))
      : 300;

    const db = getAdminFirestore();
    const agreementsSnap = await db
      .collection("paymentAgreements")
      .orderBy("createdAt", "desc")
      .limit(maxResults)
      .get();

    const agreements = agreementsSnap.docs.map((docSnap) =>
      toAgreementPayload(docSnap.id, docSnap.data() as Record<string, unknown>),
    );

    if (context.scope === "all" || context.plantelIds.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            agreements: context.scope === "all" ? agreements : [],
            scope: context.scope,
            scopePlantelIds: context.plantelIds,
          },
        },
        { status: 200 },
      );
    }

    const studentIds = Array.from(
      new Set(
        agreements
          .map((agreement) => agreement.studentId)
          .filter((studentId) => studentId.length > 0),
      ),
    );

    const studentRefs = studentIds.map((studentId) => db.collection("users").doc(studentId));
    const studentSnaps = studentRefs.length > 0 ? await db.getAll(...studentRefs) : [];
    const allowedStudentIds = new Set<string>();

    studentSnaps.forEach((studentSnap) => {
      if (!studentSnap.exists) return;
      const studentData = (studentSnap.data() ?? {}) as Record<string, unknown>;
      if (asTrimmedString(studentData.role) !== "student") return;

      const studentPlantelIds = getPlantelIds(studentData);
      if (hasAnyOverlap(context.plantelIds, studentPlantelIds)) {
        allowedStudentIds.add(studentSnap.id);
      }
    });

    const scopedAgreements = agreements.filter((agreement) =>
      allowedStudentIds.has(agreement.studentId),
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          agreements: scopedAgreements,
          scope: context.scope,
          scopePlantelIds: context.plantelIds,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
