import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { isStudentStatusActive } from "@/lib/students/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AllowedRole = "coordinadorPlantel" | "director" | "adminTeacher" | "superAdminTeacher";

type RouteContext = {
  uid: string;
  role: AllowedRole;
  plantelIds: string[];
};

type StudentPayload = {
  id: string;
  name: string;
  email: string;
  estado?: string;
  phone?: string | null;
  whatsapp?: string | null;
  program?: string;
  plantelIds?: string[];
  plantelNames?: string[];
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
  if (
    value === "coordinadorPlantel" ||
    value === "director" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
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

function resolveStudentWhatsApp(data: Record<string, unknown>): string | null {
  const candidates = [
    data.whatsapp,
    data.whatsApp,
    data.whatsappPhone,
    data.whatsappNumber,
    data.phone,
    data.telefono,
    data.tel,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
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

  if (role !== "coordinadorPlantel" && role !== "director") {
    throw new RouteAccessError(403, "Missing or insufficient permissions.");
  }

  return {
    uid,
    role,
    plantelIds: getUserPlantelIds(userData),
  };
}

async function getCoordinatorScopeGroupIds(uid: string, plantelIds: string[]): Promise<string[]> {
  const db = getAdminFirestore();
  const [plantelGroupSnaps, assignedGroupSnap] = await Promise.all([
    Promise.all(
      plantelIds.map((plantelId) =>
        db.collection("groups").where("plantelId", "==", plantelId).get(),
      ),
    ),
    db.collection("groups").where("coordinatorId", "==", uid).get(),
  ]);

  const groupIds = new Set<string>();

  plantelGroupSnaps.forEach((snap) => {
    snap.docs.forEach((docSnap) => {
      groupIds.add(docSnap.id);
    });
  });

  assignedGroupSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() as Record<string, unknown>;
    if (data.isInPerson === true) return;
    groupIds.add(docSnap.id);
  });

  return Array.from(groupIds);
}

function toStudentPayload(
  id: string,
  data: Record<string, unknown>,
): StudentPayload & { createdAtMs: number } {
  return {
    id,
    name: asTrimmedString(data.displayName) || asTrimmedString(data.name) || "Alumno",
    email: asTrimmedString(data.email),
    estado: asTrimmedString(data.estado) || asTrimmedString(data.status) || undefined,
    phone: asTrimmedString(data.phone) || null,
    whatsapp: resolveStudentWhatsApp(data),
    program: asTrimmedString(data.program) || "",
    plantelIds: getUserPlantelIds(data),
    plantelNames: asUniqueStringArray(data.plantelNames),
    createdAtMs: toMillis(data.createdAt),
  };
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

  console.error("Error obteniendo alumnos por alcance:", error);
  const message = error instanceof Error ? error.message : "Error interno del servidor";
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    { status: 500 },
  );
}

export async function GET(request: NextRequest) {
  try {
    const context = await resolveRouteContext(request);

    if (context.plantelIds.length === 0) {
      return NextResponse.json(
        {
          success: true,
          data: {
            students: [],
            totalCount: 0,
            scopeGroupIds: [],
            scopePlantelIds: [],
          },
        },
        { status: 200 },
      );
    }

    const db = getAdminFirestore();
    const [arrayScopedSnaps, legacyScopedSnaps, scopeGroupIds] = await Promise.all([
      Promise.all(
        context.plantelIds.map((plantelId) =>
          db.collection("users").where("plantelIds", "array-contains", plantelId).get(),
        ),
      ),
      Promise.all(
        context.plantelIds.map((plantelId) =>
          db.collection("users").where("plantelId", "==", plantelId).get(),
        ),
      ),
      getCoordinatorScopeGroupIds(context.uid, context.plantelIds),
    ]);

    const studentsById = new Map<string, StudentPayload & { createdAtMs: number }>();

    const consumeSnapDocs = (
      docs: Array<{ id: string; data: () => Record<string, unknown> }>,
    ) => {
      docs.forEach((docSnap) => {
        const data = docSnap.data();
        const role = asTrimmedString(data.role);
        if (role !== "student") return;

        const student = toStudentPayload(docSnap.id, data);
        if (!isStudentStatusActive(student.estado)) return;

        const current = studentsById.get(docSnap.id);
        if (!current || student.createdAtMs >= current.createdAtMs) {
          studentsById.set(docSnap.id, student);
        }
      });
    };

    arrayScopedSnaps.forEach((snap) => consumeSnapDocs(snap.docs));
    legacyScopedSnaps.forEach((snap) => consumeSnapDocs(snap.docs));

    const students = Array.from(studentsById.values())
      .sort((a, b) => {
        if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
        return a.name.localeCompare(b.name, "es");
      })
      .map((student) => ({
        id: student.id,
        name: student.name,
        email: student.email,
        estado: student.estado,
        phone: student.phone,
        whatsapp: student.whatsapp,
        program: student.program,
        plantelIds: student.plantelIds,
        plantelNames: student.plantelNames,
      }));

    return NextResponse.json(
      {
        success: true,
        data: {
          students,
          totalCount: students.length,
          scopeGroupIds,
          scopePlantelIds: context.plantelIds,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
