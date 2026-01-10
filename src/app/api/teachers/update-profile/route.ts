import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";
import { getAdminFirestore } from "@/lib/firebase/admin";

type UpdateProfileRequest = {
  teacherId: string;
  currentEmail: string;
  newEmail?: string;
  newName?: string;
  newPhone?: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: UpdateProfileRequest = await request.json();

    const { teacherId, currentEmail, newEmail, newName, newPhone } = body;

    if (!teacherId || !currentEmail) {
      return NextResponse.json(
        { error: "teacherId y currentEmail son requeridos" },
        { status: 400 }
      );
    }

    const auth = getAdminAuth();
    const firestore = getAdminFirestore();

    try {
      // Buscar usuario por email actual
      const userRecord = await auth.getUserByEmail(currentEmail.trim().toLowerCase());

      // Verificar que el UID coincida con el teacherId
      if (userRecord.uid !== teacherId) {
        return NextResponse.json(
          { error: "El ID del profesor no coincide con el email proporcionado" },
          { status: 400 }
        );
      }

      // Preparar datos de actualización para Firebase Auth
      const authUpdateData: any = {};

      // Si se proporciona un nuevo email y es diferente al actual
      if (newEmail && newEmail.trim().toLowerCase() !== currentEmail.trim().toLowerCase()) {
        // Verificar que el nuevo email no esté en uso
        try {
          await auth.getUserByEmail(newEmail.trim().toLowerCase());
          return NextResponse.json(
            { error: "El email ya está en uso por otro usuario" },
            { status: 400 }
          );
        } catch (err: any) {
          // Si el error es "user not found", el email está disponible
          if (err.code !== "auth/user-not-found") {
            throw err;
          }
        }

        authUpdateData.email = newEmail.trim().toLowerCase();
      }

      // Actualizar Firebase Auth si hay cambios de email
      if (Object.keys(authUpdateData).length > 0) {
        await auth.updateUser(userRecord.uid, authUpdateData);
      }

      // Preparar datos de actualización para Firestore
      const firestoreUpdateData: any = {
        updatedAt: new Date(),
      };

      if (newEmail && authUpdateData.email) {
        firestoreUpdateData.email = authUpdateData.email;
      }

      if (newName !== undefined) {
        firestoreUpdateData.name = newName.trim();
        firestoreUpdateData.displayName = newName.trim();
      }

      if (newPhone !== undefined) {
        firestoreUpdateData.phone = newPhone.trim();
      }

      // Actualizar en Firestore
      await firestore.collection("users").doc(userRecord.uid).update(firestoreUpdateData);

      return NextResponse.json({
        success: true,
        message: "Perfil actualizado correctamente",
        updated: {
          email: authUpdateData.email ? true : false,
          name: newName !== undefined,
          phone: newPhone !== undefined,
        },
      });
    } catch (err: any) {
      console.error("Error al actualizar perfil:", err);

      if (err.code === "auth/user-not-found") {
        return NextResponse.json(
          { error: "No se encontró el usuario con ese email" },
          { status: 404 }
        );
      }

      return NextResponse.json(
        { error: err.message || "Error al actualizar perfil" },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error en update-profile:", error);
    return NextResponse.json(
      { error: error.message || "Error interno del servidor" },
      { status: 500 }
    );
  }
}
