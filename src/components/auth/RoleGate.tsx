"use client";

import { ReactNode, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "@/lib/firebase/client";
import { resolveUserRole, UserRole } from "@/lib/firebase/roles";

type RoleGateProps = {
  allowedRole: UserRole | UserRole[];
  children: ReactNode;
};

export function RoleGate({ allowedRole, children }: RoleGateProps) {
  const router = useRouter();
  useEffect(() => {
    const allowed = Array.isArray(allowedRole) ? allowedRole : [allowedRole];
    // Render de inmediato; solo redirigimos si falla auth/rol para evitar pantallas en blanco.
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        router.replace("/");
        return;
      }

      const role = await resolveUserRole(user);

      if (!role) {
        router.replace("/");
        return;
      }

      if (!allowed.includes(role)) {
        const destination = role === "student" ? "/feed" : "/creator";
        router.replace(destination);
        return;
      }
    });

    return () => unsub();
  }, [allowedRole, router]);

  return <>{children}</>;
}
