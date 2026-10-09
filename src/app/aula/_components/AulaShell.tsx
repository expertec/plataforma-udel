"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Home, User } from "lucide-react";
import { ProductTour, type ProductTourStep } from "@/components/product-tour/ProductTour";
import { StudentViewSwitch } from "@/components/student/StudentViewSwitch";
import { LOADING_STAGES, useAulaData } from "../_lib/AulaDataContext";
import { BillingBlockedScreen } from "./BillingBlockedScreen";

const railItems = [
  { href: "/aula", icon: Home, label: "Inicio" },
  { href: "/aula/examenes-globales", icon: FileText, label: "Examenes" },
  { href: "/aula/perfil", icon: User, label: "Mi perfil" },
];

const aulaTourSteps: ProductTourStep[] = [
  {
    target: ["[data-tour='aula-rail']", "[data-tour='aula-bottom-nav']"],
    title: "Navegación del aula",
    description: "Aquí cambias entre inicio, exámenes y perfil sin salir de la vista tradicional.",
    side: "right",
  },
  {
    target: "[data-tour='aula-courses']",
    title: "Tus materias",
    description: "Cada tarjeta abre una materia y muestra el avance que llevas en sus clases.",
    side: "bottom",
  },
  {
    target: "[data-tour='aula-course-card']",
    title: "Abre una materia",
    description: "Entra desde la tarjeta para ver el temario y continuar con la siguiente clase disponible.",
    side: "bottom",
  },
  {
    target: "[data-tour='aula-class-topbar']",
    title: "Controles de clase",
    description: "Cuando estás dentro de una clase, esta barra te permite cambiar de clase o abrir el temario.",
    side: "bottom",
  },
  {
    target: "[data-tour='aula-class-stage']",
    title: "Contenido principal",
    description: "Aquí aparece el video, lectura, imagen o actividad que corresponde a la clase actual.",
    side: "bottom",
  },
  {
    target: "[data-tour='aula-class-panel']",
    title: "Participación y tareas",
    description: "Usa este panel para comentarios, foro o entrega de tarea según lo que pida la clase.",
    side: "left",
  },
  {
    target: "[data-tour='aula-view-switch']",
    title: "Cambiar de vista",
    description: "Este interruptor te lleva a la experiencia moderna tipo feed cuando quieras alternar.",
    side: "right",
  },
];

/** Barra inferior: en móvil sustituye al rail lateral, que queda oculto. */
function BottomBar() {
  const pathname = usePathname();
  return (
    <nav
      data-tour="aula-bottom-nav"
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
        <FileText size={20} />
        {railItems[1].label}
      </Link>

      <Link
        href={railItems[2].href}
        aria-current={pathname === railItems[2].href ? "page" : undefined}
        className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs transition-colors ${
          pathname === railItems[2].href
            ? "text-[var(--aula-accent-soft)]"
            : "text-[var(--aula-text-muted)]"
        }`}
      >
        <User size={20} />
        {railItems[2].label}
      </Link>
    </nav>
  );
}

function Rail() {
  const pathname = usePathname();
  const { currentUser } = useAulaData();
  return (
    <nav data-tour="aula-rail" className="fixed left-0 top-0 z-40 hidden h-screen w-14 flex-col items-center gap-2 border-r border-[var(--aula-border)] bg-[var(--aula-surface)] py-4 lg:flex">
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
      <StudentViewSwitch currentView="traditional" user={currentUser} variant="aulaRail" />
    </nav>
  );
}

export function AulaShell({ children }: { children: React.ReactNode }) {
  const { loading, loadingStage, error, billingBlocked } = useAulaData();

  if (billingBlocked) return <BillingBlockedScreen blocked={billingBlocked} />;

  if (loading) {
    const { percent, label } = LOADING_STAGES[loadingStage];
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
        <Image
          src="/university-logo.jpg"
          alt="UDEL Universidad"
          width={88}
          height={88}
          priority
          className="h-22 w-22 animate-pulse rounded-2xl object-cover"
        />

        <div className="w-full max-w-xs">
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
            className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-[var(--aula-accent)] transition-[width] duration-500 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-3 text-center text-sm text-[var(--aula-text-muted)]">{percent}%</p>
        </div>
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
      <ProductTour
        tourId="aula"
        steps={aulaTourSteps}
        className="fixed bottom-24 right-4 z-50 border-[var(--aula-border)] bg-[var(--aula-surface)] text-[var(--aula-text)] hover:bg-[var(--aula-bg)] lg:bottom-5"
      />
      {/* El padding inferior evita que la barra fija tape el final del contenido. */}
      <div className="pb-20 lg:pb-0 lg:pl-14">{children}</div>
      <BottomBar />
    </>
  );
}
