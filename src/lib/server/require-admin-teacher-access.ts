import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

type AdminTeacherRole = "adminTeacher" | "superAdminTeacher";

export type AdminTeacherAccessContext = {
  uid: string;
  email: string | null;
  role: AdminTeacherRole;
};

export class AdminTeacherAccessError extends Error {
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

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asAdminTeacherRole(value: unknown): AdminTeacherRole | null {
  return value === "adminTeacher" || value === "superAdminTeacher" ? value : null;
}

export async function requireAdminTeacherAccess(
  request: NextRequest,
): Promise<AdminTeacherAccessContext> {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (!bearerToken) {
    throw new AdminTeacherAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(bearerToken);
  } catch {
    throw new AdminTeacherAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const usersRef = getAdminFirestore().collection("users").doc(uid);
  const userSnap = await usersRef.get();
  const roleFromDoc = asAdminTeacherRole(userSnap.data()?.role);
  const roleFromClaims = asAdminTeacherRole(decodedToken.role);
  const resolvedRole = roleFromDoc ?? roleFromClaims;

  if (!resolvedRole) {
    throw new AdminTeacherAccessError(
      403,
      "Acceso restringido a adminTeacher o superAdminTeacher",
    );
  }

  return {
    uid,
    email: asText(decodedToken.email),
    role: resolvedRole,
  };
}

export function toAdminTeacherRouteErrorResponse(
  error: unknown,
  context: string,
): NextResponse {
  if (error instanceof AdminTeacherAccessError) {
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
