import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  return trimmed.slice(7).trim() || null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) {
      return NextResponse.json(
        { success: false, error: "Authorization Bearer token requerido" },
        { status: 401 },
      );
    }

    const decodedToken = await getAdminAuth().verifyIdToken(token);
    const db = getAdminFirestore();
    const userSnap = await db.collection("users").doc(decodedToken.uid).get();
    const userData = (userSnap.data() ?? {}) as Record<string, unknown>;

    if (asTrimmedString(userData.role) !== "student") {
      return NextResponse.json({ success: true, ignored: true }, { status: 200 });
    }

    const userAgent = asTrimmedString(request.headers.get("user-agent")).slice(0, 220);
    const now = FieldValue.serverTimestamp();
    const userRef = db.collection("users").doc(decodedToken.uid);
    await Promise.all([
      userRef.set({ lastLoginAt: now }, { merge: true }),
      userRef.collection("activityEvents").add({
        type: "login",
        createdAt: now,
        userAgent,
      }),
    ]);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error registrando actividad de alumno:", error);
    return NextResponse.json(
      { success: false, error: "No se pudo registrar la actividad" },
      { status: 500 },
    );
  }
}
