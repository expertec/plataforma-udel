import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

type AdminTeacherContext = {
  uid: string;
  email: string | null;
  role: "adminTeacher";
};

export class RouteAccessError extends Error {
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

export async function requireAdminTeacher(request: NextRequest): Promise<AdminTeacherContext> {
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

  const uid = decodedToken.uid;
  const usersRef = getAdminFirestore().collection("users").doc(uid);
  const userSnap = await usersRef.get();
  const roleFromDoc = asText(userSnap.data()?.role);
  const roleFromClaims = asText(decodedToken.role);
  const resolvedRole = roleFromDoc ?? roleFromClaims;

  if (resolvedRole !== "adminTeacher") {
    throw new RouteAccessError(403, "Acceso restringido a adminTeacher");
  }

  return {
    uid,
    email: decodedToken.email ?? null,
    role: "adminTeacher",
  };
}

export function toRouteErrorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
      },
      { status: error.status },
    );
  }

  console.error(context, error);
  return NextResponse.json(
    {
      success: false,
      error: "Error interno del servidor",
    },
    { status: 500 },
  );
}
