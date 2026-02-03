"use client";

import { RoleGate } from "@/components/auth/RoleGate";
import Link from "next/link";
import type { ReactNode } from "react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import { Menu, ChevronDown } from "lucide-react";
import { auth } from "@/lib/firebase/client";
import { isAdminTeacherRole, resolveUserRole, UserRole } from "@/lib/firebase/roles";
import { TeacherDataProvider } from "@/contexts/TeacherDataContext";

export default function CreatorLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setUserRole(null);
        return;
      }
      try {
        const role = await resolveUserRole(user);
        if (!cancelled) setUserRole(role);
      } catch {
        if (!cancelled) setUserRole(null);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuOpen && userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen]);

  const handleSignOut = async () => {
    setUserMenuOpen(false);
    try {
      await signOut(auth);
      router.replace("/");
    } catch (error) {
      console.error("Error al cerrar sesión", error);
    }
  };

  const displayName = currentUser?.displayName || "Profesor";
  const avatarLetter = displayName.charAt(0).toUpperCase();
  const roleLabel =
    userRole === "superAdminTeacher"
      ? "SuperAdminTeacher"
      : userRole === "adminTeacher"
        ? "AdminTeacher"
        : "Profesor";

  const isActive = (href: string) => {
    if (href === "/creator") return pathname === "/creator" || pathname === "/creator/";
    return pathname.startsWith(href);
  };

  const navItems = useMemo(() => {
    const items = [
      { href: "/creator", label: "Dashboard" },
      { href: "/creator/cursos", label: "Cursos" },
      { href: "/creator/grupos", label: "Grupos" },
      { href: "/creator/alumnos", label: "Alumnos" },
    ];
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/profesores", label: "Profesores" });
    }
    if (userRole === "superAdminTeacher") {
      items.push({ href: "/creator/programas", label: "Programas" });
    }
    return items;
  }, [userRole]);

  return (
    <RoleGate allowedRole={["teacher", "adminTeacher", "superAdminTeacher"]}>
      <TeacherDataProvider>
      <div className="flex min-h-screen w-full bg-slate-100 text-slate-900">
        {/* Sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-20 w-64 shrink-0 border-r border-slate-200 bg-white px-4 py-6 transition transform lg:translate-x-0 ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-lg font-bold text-slate-800">
              {avatarLetter || "M"}
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-500">
                Panel
              </p>
              <p className="text-sm text-slate-700">{roleLabel}</p>
            </div>
          </div>
          <nav className="mt-6 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive(item.href)
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
          <div className="mb-4 flex items-center gap-4 border-b border-slate-200 pb-4">
            <button
              type="button"
              className="flex h-12 w-12 items-center justify-center rounded-xl border-2 border-blue-500 bg-white text-blue-600 shadow-sm transition hover:shadow-md"
              onClick={() => setOpen((prev) => !prev)}
              aria-label="Abrir menú"
            >
              <Menu size={22} strokeWidth={2.2} />
            </button>

            <div className="flex flex-1 justify-end">
              <div className="relative flex items-center gap-3" ref={userMenuRef}>
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-2 py-1 pr-3 text-left shadow-sm transition hover:border-blue-200"
                  onClick={() => setUserMenuOpen((prev) => !prev)}
                  aria-label="Abrir menú de usuario"
                >
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-slate-50">
                    {currentUser?.photoURL ? (
                      <Image
                        src={currentUser.photoURL}
                        alt={displayName}
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-base font-semibold text-slate-800">
                        {avatarLetter || "P"}
                      </span>
                    )}
                  </div>
                  <div className="hidden sm:block">
                    <p className="text-xs font-semibold text-slate-700">{displayName}</p>
                  </div>
                  <ChevronDown size={16} className="text-slate-600" />
                </button>
                {userMenuOpen ? (
                  <div className="absolute right-0 top-16 w-52 rounded-lg border border-slate-200 bg-white p-2 text-sm shadow-lg">
                    <Link
                      href="/creator/perfil"
                      className="flex items-center gap-2 rounded-md px-3 py-2 text-slate-800 hover:bg-slate-100"
                      onClick={() => setUserMenuOpen(false)}
                    >
                      Ver perfil
                    </Link>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-slate-800 hover:bg-slate-100"
                      onClick={handleSignOut}
                    >
                      Cerrar sesión
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="min-h-[calc(100vh-48px)] rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            {children}
          </div>
        </main>
      </div>
      </TeacherDataProvider>
    </RoleGate>
  );
}
