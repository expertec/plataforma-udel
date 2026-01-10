import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";

type UpdatePasswordRequest = {
  teacherId: string;
  currentEmail: string;
  newPassword: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: UpdatePasswordRequest = await request.json();

    const { teacherId, currentEmail, newPassword } = body;

    if (!teacherId || !currentEmail || !newPassword) {
      return NextResponse.json(
        { error: "teacherId, currentEmail y newPassword son requeridos" },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "La contraseña debe tener al menos 6 caracteres" },
        { status: 400 }
      );
    }

    const auth = getAdminAuth();

    try {
      // Buscar usuario por email
      const userRecord = await auth.getUserByEmail(currentEmail.trim().toLowerCase());

      // Verificar que el UID coincida con el teacherId
      if (userRecord.uid !== teacherId) {
        return NextResponse.json(
          { error: "El ID del profesor no coincide con el email proporcionado" },
          { status: 400 }
        );
      }

      // Actualizar contraseña en Firebase Auth
      await auth.updateUser(userRecord.uid, {
        password: newPassword,
      });

      return NextResponse.json({
        success: true,
        message: "Contraseña actualizada correctamente",
      });
    } catch (err: any) {
      console.error("Error al actualizar contraseña:", err);

      if (err.code === "auth/user-not-found") {
        return NextResponse.json(
          { error: "No se encontró el usuario con ese email" },
          { status: 404 }
        );
      }

      return NextResponse.json(
        { error: err.message || "Error al actualizar contraseña" },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error en update-password:", error);
    return NextResponse.json(
      { error: error.message || "Error interno del servidor" },
      { status: 500 }
    );
  }
}
