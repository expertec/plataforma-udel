"use client";

import { ReactNode, useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { db } from "@/lib/firebase/firestore";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";
import { getStudentHomeRoute, normalizeStudentPlatformView } from "@/lib/student-platform-view";

type RoleGateProps = {
  allowedRole: UserRole | UserRole[];
  children: ReactNode;
};

async function resolveRoleHome(userId: string, role: UserRole): Promise<string> {
  if (role === "student") {
    try {
      const userSnap = await getDoc(doc(db, "users", userId));
      return getStudentHomeRoute(normalizeStudentPlatformView(userSnap.data()?.preferredStudentView));
    } catch {
      return "/feed";
    }
  }
  return "/creator";
}

export function RoleGate({ allowedRole, children }: RoleGateProps) {
  const router = useRouter();
  const [roleError, setRoleError] = useState<string | null>(null);
  useEffect(() => {
    const allowed = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
    // Render de inmediato; solo redirigimos si falla auth/rol para evitar pantallas en blanco.
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (!user) {
          router.replace("/");
          return;
        }

        const role = await resolveUserRole(user);

        if (!role) {
          setRoleError("No se pudo validar tu rol. Intenta de nuevo.");
          router.replace("/");
          return;
        }

        if (!allowed.includes(role)) {
          const destination = await resolveRoleHome(user.uid, role);
          router.replace(destination);
          return;
        }
        setRoleError(null);
      } catch (err) {
        console.error("Error validando rol:", err);
        setRoleError("No se pudo validar tu sesión. Revisa tu conexión e intenta de nuevo.");
        router.replace("/");
      }
    });

    return () => unsub();
  }, [allowedRole, router]);

  if (roleError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-800">
        <div className="max-w-md rounded-xl border border-amber-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-amber-800">{roleError}</p>
          <p className="mt-2 text-sm text-slate-600">Refresca la página para reintentar.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
