import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export type TeacherAccessRole =
  | "teacher"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel"
  | "director";

export type TeacherAccessContext = {
  uid: string;
  email: string | null;
  role: TeacherAccessRole;
  displayName: string;
};

export class TeacherAccessError extends Error {
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

function asTeacherRole(value: unknown): TeacherAccessRole | null {
  if (
    value === "teacher" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel" ||
    value === "director"
  ) {
    return value;
  }
  return null;
}

export async function requireTeacherAccess(
  request: NextRequest,
): Promise<TeacherAccessContext> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    throw new TeacherAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(bearerToken);
  } catch {
    throw new TeacherAccessError(401, "Token invalido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
  const role = asTeacherRole(userData.role) ?? asTeacherRole(decodedToken.role);
  if (!role) {
    throw new TeacherAccessError(403, "Acceso restringido a profesores");
  }

  return {
    uid,
    role,
    email: asTrimmedString(userData.email) || decodedToken.email || null,
    displayName:
      asTrimmedString(userData.name) ||
      asTrimmedString(userData.displayName) ||
      asTrimmedString(decodedToken.name) ||
      asTrimmedString(decodedToken.email) ||
      "Profesor",
  };
}

export function toTeacherAccessErrorResponse(
  error: unknown,
  context: string,
): NextResponse {
  if (error instanceof TeacherAccessError) {
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
