import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { ARCHIVED_STUDENT_STATUS } from "@/lib/students/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ArchivedAllowedRole = "adminTeacher" | "superAdminTeacher" | "coordinadorPlantel" | "director";

type ArchivedAccessContext = {
  uid: string;
  role: ArchivedAllowedRole;
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

function asAllowedRole(value: unknown): ArchivedAllowedRole | null {
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

function isGlobalArchiveRole(role: ArchivedAllowedRole): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

function toMillis(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "object" && value !== null) {
    if ("toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
      try {
        return (value as { toMillis: () => number }).toMillis();
      } catch {
        return 0;
      }
    }
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        return (value as { toDate: () => Date }).toDate().getTime();
      } catch {
        return 0;
      }
    }
    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      return Math.trunc(seconds * 1000 + nanos / 1_000_000);
    }
  }
  return 0;
}

async function resolveArchivedAccess(request: NextRequest): Promise<ArchivedAccessContext> {
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
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error obteniendo bajas", error);
  const message =
    process.env.NODE_ENV !== "production" && error instanceof Error
      ? error.message.trim() || "Error interno del servidor"
      : "Error interno del servidor";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const accessContext = await resolveArchivedAccess(request);
    if (!isGlobalArchiveRole(accessContext.role) && accessContext.plantelIds.length === 0) {
      return NextResponse.json({ success: true, data: { students: [] } }, { status: 200 });
    }

    const db = getAdminFirestore();
    const snaps = isGlobalArchiveRole(accessContext.role)
      ? [
          await db
            .collection("users")
            .where("role", "==", "student")
            .where("status", "==", ARCHIVED_STUDENT_STATUS)
            .limit(500)
            .get(),
        ]
      : await Promise.all(
          accessContext.plantelIds.map((plantelId) =>
            db
              .collection("users")
              .where("role", "==", "student")
              .where("status", "==", ARCHIVED_STUDENT_STATUS)
              .where("archivedPlantelIds", "array-contains", plantelId)
              .limit(500)
              .get(),
          ),
        );

    const studentsById = new Map<string, Record<string, unknown> & { id: string; archivedAtMs: number }>();
    snaps.forEach((snap) => {
      snap.docs.forEach((docSnap) => {
        const data = docSnap.data() as Record<string, unknown>;
        const archivedAtMs = toMillis(data.archivedAt);
        const current = studentsById.get(docSnap.id);
        if (!current || archivedAtMs >= current.archivedAtMs) {
          studentsById.set(docSnap.id, { ...data, id: docSnap.id, archivedAtMs });
        }
      });
    });

    const students = Array.from(studentsById.values())
      .sort((a, b) => b.archivedAtMs - a.archivedAtMs)
      .map((data) => {
        const archivedPlantelNames = asUniqueStringArray(data.archivedPlantelNames);
        const archivedPlantelIds = asUniqueStringArray(data.archivedPlantelIds);
        return {
          id: data.id,
          name: asTrimmedString(data.displayName) || asTrimmedString(data.name) || "Alumno",
          email: asTrimmedString(data.email),
          program: asTrimmedString(data.program),
          plantelIds: archivedPlantelIds,
          plantelNames: archivedPlantelNames,
          archivedAt: data.archivedAtMs > 0 ? new Date(data.archivedAtMs).toISOString() : null,
          archivedReasonType: asTrimmedString(data.archivedReasonType),
          archivedReason: asTrimmedString(data.archivedReason),
        };
      });

    return NextResponse.json({ success: true, data: { students } }, { status: 200 });
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
