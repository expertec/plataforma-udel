"use client";

import { RoleGate } from "@/components/auth/RoleGate";
import Link from "next/link";
import type { ReactNode } from "react";
import { useState } from "react";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/creator/cursos", label: "Cursos" },
  { href: "/creator/grupos", label: "Grupos" },
  { href: "/creator/alumnos", label: "Alumnos" },
];

export default function CreatorLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <RoleGate allowedRole="teacher">
      <div className="flex min-h-screen w-full bg-slate-100 text-slate-900">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-20 w-64 shrink-0 border-r border-slate-200 bg-white px-4 py-6 transition transform lg:translate-x-0 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-lg font-bold text-slate-800">
              M
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                Panel
              </p>
              <p className="text-sm text-slate-700">Profesor</p>
            </div>
          </div>
          <nav className="mt-6 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  pathname.startsWith(item.href)
                    ? "bg-slate-200 text-slate-900"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
                onClick={() => setOpen(false)}
              >
                <span className="h-2 w-2 rounded-full bg-slate-400" />
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Overlay mobile */}
        {open ? (
          <button
            type="button"
            aria-label="Cerrar menú"
            className="fixed inset-0 z-10 bg-black/40 lg:hidden"
            onClick={() => setOpen(false)}
          />
        ) : null}

        <main className="flex-1 overflow-auto px-4 py-6 sm:px-6 lg:pl-72 lg:pr-8">
          <div className="mb-4 flex items-center justify-between lg:hidden">
            <button
              type="button"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm"
              onClick={() => setOpen(true)}
            >
              Menú
            </button>
          </div>
          <div className="min-h-[calc(100vh-48px)] rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            {children}
          </div>
        </main>
      </div>
    </RoleGate>
  );
}
