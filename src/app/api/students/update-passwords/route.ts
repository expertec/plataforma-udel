import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase/admin";

type UpdatePasswordRequest = {
  email: string;
  newPassword: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: UpdatePasswordRequest[] = await request.json();

    if (!Array.isArray(body)) {
      return NextResponse.json(
        { error: "Se esperaba un array de actualizaciones" },
        { status: 400 }
      );
    }

    const auth = getAdminAuth();
    const results: Array<{
      email: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const update of body) {
      const { email, newPassword } = update;

      if (!email || !newPassword) {
        results.push({
          email: email || "desconocido",
          success: false,
          error: "Email y contraseña son requeridos",
        });
        continue;
      }

      try {
        // Buscar usuario por email
        const userRecord = await auth.getUserByEmail(email.trim().toLowerCase());

        // Actualizar contraseña
        await auth.updateUser(userRecord.uid, {
          password: newPassword,
        });

        results.push({
          email,
          success: true,
        });
      } catch (err: any) {
        results.push({
          email,
          success: false,
          error: err.message || "Error al actualizar contraseña",
        });
      }
    }

    return NextResponse.json({
      success: true,
      results,
      summary: {
        total: results.length,
        updated: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      },
    });
  } catch (error: any) {
    console.error("Error en update-passwords:", error);
    return NextResponse.json(
      { error: error.message || "Error interno del servidor" },
      { status: 500 }
    );
  }
}
