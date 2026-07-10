import type { Metadata } from "next";
import { AulaDataProvider } from "./_lib/AulaDataContext";
import { AulaShell } from "./_components/AulaShell";

export const metadata: Metadata = {
  title: "Aula | UDEL Universidad",
};

export default function AulaLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="aula-shell min-h-screen bg-[var(--aula-bg)] text-[var(--aula-text)]">
      <AulaDataProvider>
        <AulaShell>{children}</AulaShell>
      </AulaDataProvider>
    </div>
  );
}
