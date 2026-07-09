import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { buildPhoneLookupValues } from "@/lib/utils/phone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UpdateProfileRequest = {
  studentId?: string;
  currentEmail?: string;
  newEmail?: string;
  newName?: string;
  newPhone?: string;
  newProgram?: string;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as UpdateProfileRequest;
    const studentId = normalizeText(body.studentId);
    const currentEmail = normalizeEmail(body.currentEmail);

    if (!studentId) {
      return NextResponse.json(
        { success: false, error: "studentId es requerido" },
        { status: 400 },
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();
    const userRecord = await auth.getUser(studentId);

    const currentAuthEmail = normalizeEmail(userRecord.email);
    if (currentEmail && currentAuthEmail && currentEmail !== currentAuthEmail) {
      return NextResponse.json(
        { success: false, error: "El email actual no coincide con el usuario indicado" },
        { status: 400 },
      );
    }

    const requestedEmail = normalizeEmail(body.newEmail);
    const nextName = body.newName !== undefined ? normalizeText(body.newName) : undefined;
    const nextPhone = body.newPhone !== undefined ? normalizeText(body.newPhone) : undefined;
    const nextProgram = body.newProgram !== undefined ? normalizeText(body.newProgram) : undefined;

    const authUpdateData: {
      email?: string;
      displayName?: string;
    } = {};

    if (requestedEmail && requestedEmail !== currentAuthEmail) {
      try {
        const existingUser = await auth.getUserByEmail(requestedEmail);
        if (existingUser.uid !== studentId) {
          return NextResponse.json(
            { success: false, error: "El email ya está en uso por otro usuario" },
            { status: 400 },
          );
        }
      } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== "auth/user-not-found") {
          throw error;
        }
      }
      authUpdateData.email = requestedEmail;
    }

    if (nextName !== undefined && nextName !== normalizeText(userRecord.displayName)) {
      authUpdateData.displayName = nextName;
    }

    if (Object.keys(authUpdateData).length > 0) {
      await auth.updateUser(studentId, authUpdateData);
    }

    const now = new Date();
    const userUpdateData: Record<string, unknown> = {
      updatedAt: now,
    };

    if (authUpdateData.email) {
      userUpdateData.email = authUpdateData.email;
    }

    if (nextName !== undefined) {
      userUpdateData.name = nextName;
      userUpdateData.displayName = nextName;
    }

    if (nextPhone !== undefined) {
      userUpdateData.phone = nextPhone || null;
      userUpdateData.lookupPhones = buildPhoneLookupValues([nextPhone]);
    }

    if (nextProgram !== undefined) {
      userUpdateData.program = nextProgram;
    }

    const [enrollmentsSnap, archiveEnrollmentsSnap] = await Promise.all([
      firestore.collection("studentEnrollments").where("studentId", "==", studentId).get(),
      firestore.collection("studentEnrollmentsArchive").where("studentId", "==", studentId).get(),
    ]);

    const groupIds = new Set<string>();
    enrollmentsSnap.docs.forEach((docSnap) => {
      const groupId = normalizeText(docSnap.data().groupId);
      if (groupId) groupIds.add(groupId);
    });
    archiveEnrollmentsSnap.docs.forEach((docSnap) => {
      const groupId = normalizeText(docSnap.data().groupId);
      if (groupId) groupIds.add(groupId);
    });

    const membershipSnaps = await Promise.all(
      Array.from(groupIds).map((groupId) =>
        firestore.collection("groups").doc(groupId).collection("students").doc(studentId).get(),
      ),
    );

    const batch = firestore.batch();
    batch.set(firestore.collection("users").doc(studentId), userUpdateData, { merge: true });

    if (nextName !== undefined || authUpdateData.email) {
      const enrollmentUpdateData: Record<string, unknown> = {
        updatedAt: now,
      };
      if (nextName !== undefined) {
        enrollmentUpdateData.studentName = nextName;
      }
      if (authUpdateData.email) {
        enrollmentUpdateData.studentEmail = authUpdateData.email;
      }

      enrollmentsSnap.docs.forEach((docSnap) => {
        batch.set(docSnap.ref, enrollmentUpdateData, { merge: true });
      });

      archiveEnrollmentsSnap.docs.forEach((docSnap) => {
        batch.set(docSnap.ref, enrollmentUpdateData, { merge: true });
      });

      membershipSnaps.forEach((docSnap) => {
        if (!docSnap.exists) return;
        const membershipUpdateData: Record<string, unknown> = {
          updatedAt: now,
        };
        if (nextName !== undefined) {
          membershipUpdateData.studentName = nextName;
        }
        if (authUpdateData.email) {
          membershipUpdateData.studentEmail = authUpdateData.email;
        }
        batch.set(docSnap.ref, membershipUpdateData, { merge: true });
      });
    }

    await batch.commit();

    return NextResponse.json({
      success: true,
      message: "Perfil actualizado correctamente",
      updated: {
        email: Boolean(authUpdateData.email),
        name: nextName !== undefined,
        phone: nextPhone !== undefined,
        program: nextProgram !== undefined,
      },
    });
  } catch (error) {
    console.error("Error en students/update-profile:", error);
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "auth/user-not-found") {
      return NextResponse.json(
        { success: false, error: "No se encontró el alumno indicado" },
        { status: 404 },
      );
    }

    const message = error instanceof Error ? error.message : "Error interno del servidor";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
