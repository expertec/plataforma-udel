"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { User, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebase/client";

export default function PerfilPage() {
  const [user, setUser] = useState<User | null>(auth.currentUser);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (current) => setUser(current));
    return () => unsub();
  }, []);

  const displayName = user?.displayName ?? "Profesor";
  const email = user?.email ?? "Sin correo registrado";

  return (
    <div className="space-y-6 text-slate-900">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Perfil</p>
          <h1 className="text-3xl font-semibold text-slate-900">Perfil del profesor</h1>
          <p className="text-sm text-slate-600">
            Actualiza tus datos y revisa tu información básica de cuenta.
          </p>
        </div>
        <Link
          href="/creator"
          className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition hover:border-blue-500 hover:text-blue-700"
        >
          ← Volver al dashboard
        </Link>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="flex items-center gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-50">
            {user?.photoURL ? (
              <Image
                src={user.photoURL}
                alt={displayName}
                width={80}
                height={80}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-xl font-semibold text-slate-800">
                {displayName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-900">{displayName}</h2>
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
                Profesor
              </span>
            </div>
            <p className="text-sm text-slate-600">{email}</p>
            <p className="text-xs text-slate-500">
              ID de usuario: <span className="font-mono">{user?.uid ?? "N/D"}</span>
            </p>
          </div>
        </section>

        <section className="space-y-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm">
          <h3 className="text-lg font-semibold text-slate-900">Accesos rápidos</h3>
          <div className="grid gap-3">
            <Link
              href="/creator/cursos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Gestionar cursos
              <span className="text-blue-600">→</span>
            </Link>
            <Link
              href="/creator/grupos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Ver grupos y cohortes
              <span className="text-blue-600">→</span>
            </Link>
            <Link
              href="/creator/alumnos"
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-800 transition hover:border-blue-300"
            >
              Panel de alumnos
              <span className="text-blue-600">→</span>
            </Link>
          </div>
        </section>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-lg font-semibold text-slate-900">Información de la cuenta</h3>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Nombre</dt>
            <dd className="text-sm font-semibold text-slate-900">{displayName}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Correo</dt>
            <dd className="text-sm font-semibold text-slate-900">{email}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">UID</dt>
            <dd className="font-mono text-sm text-slate-800">{user?.uid ?? "N/D"}</dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <dt className="text-xs uppercase tracking-[0.2em] text-slate-500">Proveedor</dt>
            <dd className="text-sm font-semibold text-slate-900">
              {user?.providerData?.[0]?.providerId ?? "Desconocido"}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          Para actualizar tu foto o nombre usa tu perfil del proveedor (Google/Email) y vuelve a iniciar sesión.
        </p>
      </section>
    </div>
  );
}
