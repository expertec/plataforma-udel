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
import {
  hasUserExtraRole,
  isAdminTeacherRole,
  isCampusCoordinatorRole,
  isDirectorRole,
  resolveUserRoleAccessProfile,
  UserRole,
} from "@/lib/firebase/roles";
import { TeacherDataProvider } from "@/contexts/TeacherDataContext";

export default function CreatorLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [hasDirectorExtraRole, setHasDirectorExtraRole] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setUserRole(null);
        setHasDirectorExtraRole(false);
        return;
      }
      try {
        const accessProfile = await resolveUserRoleAccessProfile(user);
        if (!cancelled) {
          setUserRole(accessProfile.role);
          setHasDirectorExtraRole(hasUserExtraRole(accessProfile.extraRoles, "director"));
        }
      } catch {
        if (!cancelled) {
          setUserRole(null);
          setHasDirectorExtraRole(false);
        }
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    const syncSidebarStateWithViewport = () => {
      if (window.innerWidth >= 1024) {
        setOpen(true);
      }
    };
    syncSidebarStateWithViewport();
    window.addEventListener("resize", syncSidebarStateWithViewport);
    return () => window.removeEventListener("resize", syncSidebarStateWithViewport);
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
        : userRole === "director"
          ? "Director de plantel"
          : isCampusCoordinatorRole(userRole)
            ? "Coordinador de plantel"
            : "Profesor";

  const isActive = (href: string) => {
    if (href === "/creator") return pathname === "/creator" || pathname === "/creator/";
    return pathname.startsWith(href);
  };

  const navItems = useMemo(() => {
    const canAccessConvenios =
      userRole === "adminTeacher" ||
      isDirectorRole(userRole) ||
      (isCampusCoordinatorRole(userRole) && hasDirectorExtraRole);

    const items = [
      { href: "/creator", label: "Dashboard" },
      { href: "/creator/asistencia", label: "Asistencia" },
      { href: "/creator/cursos", label: "Cursos" },
      { href: "/creator/grupos", label: "Grupos" },
    ];
    if (userRole === "teacher" || isAdminTeacherRole(userRole) || isCampusCoordinatorRole(userRole)) {
      items.push({ href: "/creator/mis-clases-en-vivo", label: "Clases En Vivo" });
    }
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/clases-en-vivo", label: "Clases en vivo" });
    }
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/planteles", label: "Planteles" });
    }
    items.push({ href: "/creator/alumnos", label: "Alumnos" });
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/encuestas", label: "Encuestas" });
    }
    if (isAdminTeacherRole(userRole) || isCampusCoordinatorRole(userRole)) {
      items.push({ href: "/creator/examenes-globales", label: "Examenes globales" });
    }
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/profesores", label: "Profesores" });
    }
    if (isAdminTeacherRole(userRole) || isCampusCoordinatorRole(userRole)) {
      items.push({ href: "/creator/cierre-materias", label: "Cierre de materias" });
    }
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/diagnostico-permisos", label: "Diagnóstico de permisos" });
    }
    if (isAdminTeacherRole(userRole)) {
      items.push({ href: "/creator/programas", label: "Programas" });
    }
    if (canAccessConvenios) {
      items.push({ href: "/creator/convenios", label: "Convenios" });
    }
    if (userRole === "adminTeacher") {
      items.push({ href: "/creator/api", label: "API" });
    }
    return items;
  }, [hasDirectorExtraRole, userRole]);

  return (
    <RoleGate
      allowedRole={[
        "teacher",
        "adminTeacher",
        "superAdminTeacher",
        "coordinadorPlantel",
        "director",
      ]}
    >
      <TeacherDataProvider>
      <div className="creator-shell flex min-h-screen w-full">
        {/* Sidebar */}
        <aside
          className={`creator-sidebar fixed inset-y-0 left-0 z-20 w-72 shrink-0 border-r px-4 py-6 text-white transition transform ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-center py-2">
            <Image
              src="/university-logo.jpg"
              alt="Logo UDEL Universidad"
              width={48}
              height={48}
              className="h-12 w-12 object-cover"
              priority
            />
          </div>
          <nav className="mt-6 space-y-1.5">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                  isActive(item.href)
                    ? "bg-white/12 text-white shadow-lg shadow-black/10"
                    : "text-white/75 hover:bg-white/8 hover:text-white"
                }`}
                onClick={() => {
                  if (window.innerWidth < 1024) {
                    setOpen(false);
                  }
                }}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full transition ${
                    isActive(item.href)
                      ? "bg-white shadow-[0_0_0_4px_rgba(255,255,255,0.14)]"
                      : "bg-white/30 group-hover:bg-white"
                  }`}
                />
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
            className="fixed inset-0 z-10 bg-[#2b1116]/55 backdrop-blur-[2px] lg:hidden"
            onClick={() => setOpen(false)}
          />
        ) : null}

        <main className={`flex-1 overflow-auto px-4 py-6 sm:px-6 ${open ? "lg:pl-80 lg:pr-8" : "lg:px-8"}`}>
          <div className="creator-panel mb-4 flex items-center gap-4 rounded-[1.75rem] px-4 py-4 sm:px-5">
            <button
              type="button"
              className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[#b67a68]/35 bg-[#fffaf7] text-[#6e2d2d] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              onClick={() => setOpen((prev) => !prev)}
              aria-label={open ? "Ocultar menú" : "Abrir menú"}
            >
              <Menu size={22} strokeWidth={2.2} />
            </button>

            <div className="hidden min-w-0 flex-1 lg:block">
              <p className="text-xs uppercase tracking-[0.35em] text-[#8c5e57]">Universidad de Liderazgo Integral</p>
              <p className="truncate text-lg font-semibold text-[#551b22]">Panel institucional para maestros</p>
            </div>

            <div className="flex flex-1 justify-end lg:flex-none">
              <div className="relative flex items-center gap-3" ref={userMenuRef}>
                <button
                  type="button"
                  className="flex items-center gap-3 rounded-full border border-[#d9b1a1] bg-[#fffaf7] px-2 py-1 pr-3 text-left shadow-sm transition hover:border-[#b67a68]"
                  onClick={() => setUserMenuOpen((prev) => !prev)}
                  aria-label="Abrir menú de usuario"
                >
                  <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-[#d9b1a1] bg-[#f3e3db]">
                    {currentUser?.photoURL ? (
                      <Image
                        src={currentUser.photoURL}
                        alt={displayName}
                        width={48}
                        height={48}
                        className="h-full w-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <span className="text-base font-semibold text-[#551b22]">
                        {avatarLetter || "P"}
                      </span>
                    )}
                  </div>
                  <div className="hidden sm:block">
                    <p className="text-xs font-semibold text-[#551b22]">{displayName}</p>
                    <p className="text-[11px] uppercase tracking-[0.28em] text-[#9f6e61]">{roleLabel}</p>
                  </div>
                  <ChevronDown size={16} className="text-[#7b4c49]" />
                </button>
                {userMenuOpen ? (
                  <div className="absolute right-0 top-16 w-52 rounded-2xl border border-[#d9b1a1] bg-[#fffaf7] p-2 text-sm shadow-[0_20px_40px_rgba(85,27,34,0.12)]">
                    <Link
                      href="/creator/perfil"
                      className="flex items-center gap-2 rounded-xl px-3 py-2 text-[#551b22] hover:bg-[#f3e3db]"
                      onClick={() => setUserMenuOpen(false)}
                    >
                      Ver perfil
                    </Link>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[#551b22] hover:bg-[#f3e3db]"
                      onClick={handleSignOut}
                    >
                      Cerrar sesión
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="creator-panel min-h-[calc(100vh-48px)] rounded-[2rem] p-4 sm:p-6">
            {children}
          </div>
        </main>
      </div>
      </TeacherDataProvider>
    </RoleGate>
  );
}
