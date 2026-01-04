/** Client-side login card; placeholder submit routes by rol. */
"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import { resolveUserRole } from "@/lib/firebase/roles";
import Image from "next/image";

type LoginCardProps = {
  title?: string;
  subtitle?: string;
};

export function LoginCard({
  title = "Acceder",
  subtitle = "Ingresa con tu correo y contraseña.",
}: LoginCardProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    signInWithEmailAndPassword(auth, email, password)
      .then(async (cred) => {
        const role = await resolveUserRole(cred.user);
        if (!role) {
          toast.error("No se encontró un rol asignado.");
          return;
        }
        const destination = role === "teacher" ? "/creator" : "/feed";
        toast.success("Inicio de sesión correcto");
        if (remember) {
          // noop placeholder; add persistence here si se requiere.
        }
        router.push(destination);
      })
      .catch((error) => {
        const message =
          error?.code === "auth/invalid-credential"
            ? "Credenciales inválidas."
            : "No se pudo iniciar sesión. Intenta de nuevo.";
        toast.error(message);
      })
      .finally(() => setLoading(false));
  };

  return (
    <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 text-slate-900 shadow-2xl shadow-slate-900/5 sm:p-10">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 shadow-sm">
          <Image
            src="/university-logo.jpg"
            alt="Logo Udel Universidad"
            width={48}
            height={48}
            className="object-cover"
            priority
          />
        </div>
        <div className="space-y-1">
          <h2 className="text-3xl font-bold text-[#6e2d2d]">{title}</h2>
          <p className="text-sm text-slate-600">{subtitle}</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div className="space-y-1.5">
          <label className="text-base font-semibold text-slate-800">
            Nombre de usuario o dirección de correo
          </label>
          <input
            type="email"
            name="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@email.com"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-[#6e2d2d] focus:outline-none focus:ring-1 focus:ring-[#6e2d2d]"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center justify-between text-base font-semibold text-slate-800">
            <span>Contraseña</span>
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="text-sm font-medium text-[#6e2d2d] hover:opacity-80"
            >
              {showPassword ? "Ocultar" : "Mostrar"} contraseña
            </button>
          </label>
          <input
            type={showPassword ? "text" : "password"}
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base text-slate-900 placeholder:text-slate-400 focus:border-[#6e2d2d] focus:outline-none focus:ring-1 focus:ring-[#6e2d2d]"
            required
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-700">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-[#6e2d2d] focus:ring-[#6e2d2d]"
            />
            Recuérdame
          </label>
          <button
            type="button"
            className="font-medium text-[#6e2d2d] hover:opacity-80"
          >
            ¿Has perdido tu contraseña?
          </button>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center rounded-lg bg-[#6e2d2d] px-4 py-3 text-base font-semibold text-white transition hover:bg-[#5c2626] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? "Accediendo..." : "Acceder"}
        </button>
      </form>

      <p className="mt-6 text-sm text-slate-700">
        ¿Aún no tienes cuenta?{" "}
        <Link
          href="/(auth)/register"
          className="font-semibold text-[#6e2d2d] hover:opacity-80"
        >
          Regístrate aquí
        </Link>
      </p>
    </div>
  );
}
