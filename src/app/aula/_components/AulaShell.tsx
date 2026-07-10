"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Loader2, User } from "lucide-react";
import { useAulaData } from "../_lib/AulaDataContext";
import { BillingBlockedScreen } from "./BillingBlockedScreen";

const railItems = [
  { href: "/aula", icon: Home, label: "Inicio" },
  { href: "/aula/perfil", icon: User, label: "Mi perfil" },
];

/** Barra inferior: en móvil sustituye al rail lateral, que queda oculto. */
function BottomBar() {
  const pathname = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--aula-border)] bg-[var(--aula-surface)] pb-[env(safe-area-inset-bottom)] lg:hidden"
      aria-label="Navegación principal"
    >
      <Link
        href={railItems[0].href}
        aria-current={pathname === railItems[0].href ? "page" : undefined}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition-colors ${
          pathname === railItems[0].href
            ? "text-[var(--aula-accent-soft)]"
            : "text-[var(--aula-text-muted)]"
        }`}
      >
        <Home size={20} />
        {railItems[0].label}
      </Link>

      <div className="flex flex-1 items-center justify-center">
        <Image
          src="/university-logo.jpg"
          alt="UDEL"
          width={36}
          height={36}
          className="h-9 w-9 rounded-lg object-cover"
        />
      </div>

      <Link
        href={railItems[1].href}
        aria-current={pathname === railItems[1].href ? "page" : undefined}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition-colors ${
          pathname === railItems[1].href
            ? "text-[var(--aula-accent-soft)]"
            : "text-[var(--aula-text-muted)]"
        }`}
      >
        <User size={20} />
        {railItems[1].label}
      </Link>
    </nav>
  );
}

function Rail() {
  const pathname = usePathname();
  return (
    <nav className="fixed left-0 top-0 z-40 hidden h-screen w-14 flex-col items-center gap-2 border-r border-[var(--aula-border)] bg-[var(--aula-surface)] py-4 lg:flex">
      <Link href="/aula" aria-label="Inicio del aula" className="mb-4 shrink-0">
        <Image
          src="/university-logo.jpg"
          alt="UDEL"
          width={36}
          height={36}
          className="h-9 w-9 rounded-lg object-cover"
        />
      </Link>
      {railItems.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-label={item.label}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors ${
              active
                ? "bg-[var(--aula-accent)]/20 text-[var(--aula-accent-soft)]"
                : "text-[var(--aula-text-muted)] hover:bg-white/5 hover:text-[var(--aula-text)]"
            }`}
          >
            <item.icon size={20} />
          </Link>
        );
      })}
    </nav>
  );
}

export function AulaShell({ children }: { children: React.ReactNode }) {
  const { loading, error, billingBlocked } = useAulaData();

  if (billingBlocked) return <BillingBlockedScreen blocked={billingBlocked} />;

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-[var(--aula-text-muted)]">
        <Loader2 size={28} className="animate-spin" />
        <p className="text-sm">Cargando tus clases…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-md rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center">
          <h2 className="text-lg font-semibold text-[var(--aula-text)]">No pudimos abrir el aula</h2>
          <p className="mt-2 text-sm text-[var(--aula-text-muted)]">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Rail />
      {/* El padding inferior evita que la barra fija tape el final del contenido. */}
      <div className="pb-20 lg:pb-0 lg:pl-14">{children}</div>
      <BottomBar />
    </>
  );
}
