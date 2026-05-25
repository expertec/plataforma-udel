import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export type GlobalExamAccessRole =
  | "student"
  | "coordinadorPlantel"
  | "adminTeacher"
  | "superAdminTeacher";

export type GlobalExamAccessContext = {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: GlobalExamAccessRole;
  plantelIds: string[];
};

export class GlobalExamAccessError extends Error {
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

function asGlobalExamRole(value: unknown): GlobalExamAccessRole | null {
  return value === "student" ||
    value === "coordinadorPlantel" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher"
    ? value
    : null;
}

function getUserPlantelIds(userData: Record<string, unknown>): string[] {
  const plantelIds = asUniqueStringArray(userData.plantelIds);
  if (plantelIds.length > 0) return plantelIds;
  const legacyPlantelId = asTrimmedString(userData.plantelId);
  return legacyPlantelId ? [legacyPlantelId] : [];
}

export function isGlobalExamAdminRole(role: GlobalExamAccessRole): boolean {
  return role === "adminTeacher" || role === "superAdminTeacher";
}

export function isGlobalExamCoordinatorRole(role: GlobalExamAccessRole): boolean {
  return role === "coordinadorPlantel";
}

export function isGlobalExamStudentRole(role: GlobalExamAccessRole): boolean {
  return role === "student";
}

export async function requireGlobalExamAccess(
  request: NextRequest,
  allowedRoles: GlobalExamAccessRole[],
): Promise<GlobalExamAccessContext> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    throw new GlobalExamAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(bearerToken);
  } catch {
    throw new GlobalExamAccessError(401, "Token invalido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asGlobalExamRole(userData.role) ?? asGlobalExamRole(decodedToken.role);

  if (!role || !allowedRoles.includes(role)) {
    throw new GlobalExamAccessError(403, "Missing or insufficient permissions.");
  }

  const displayName =
    asTrimmedString(userData.displayName) ||
    asTrimmedString(userData.name) ||
    asTrimmedString(decodedToken.name) ||
    asTrimmedString(decodedToken.email) ||
    null;

  return {
    uid,
    email: asTrimmedString(decodedToken.email) || null,
    displayName,
    role,
    plantelIds: getUserPlantelIds(userData),
  };
}

export async function getCoordinatorScopeGroupIds(
  uid: string,
  plantelIds: string[],
): Promise<string[]> {
  const db = getAdminFirestore();
  const [plantelGroupSnaps, assignedGroupSnap] = await Promise.all([
    Promise.all(
      plantelIds.map((plantelId) => db.collection("groups").where("plantelId", "==", plantelId).get()),
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

export function toGlobalExamRouteErrorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof GlobalExamAccessError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status },
    );
  }

  console.error(context, error);
  if (process.env.NODE_ENV !== "production" && error instanceof Error) {
    return NextResponse.json(
      {
        success: false,
        error: error.message.trim() || "Error interno del servidor",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      success: false,
      error: "Error interno del servidor",
    },
    { status: 500 },
  );
}
