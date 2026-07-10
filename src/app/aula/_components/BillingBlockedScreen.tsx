"use client";

import { useState } from "react";
import { AlertTriangle, Copy, Check } from "lucide-react";
import toast from "react-hot-toast";
import { BILLING_SUPPORT_WHATSAPP_URL, formatCurrency } from "../_lib/billing";
import type { BillingBlockedState } from "../_lib/types";

export function BillingBlockedScreen({ blocked }: { blocked: BillingBlockedState }) {
  const [copied, setCopied] = useState(false);

  const copyClabe = async () => {
    if (!blocked.clabe) return;
    try {
      await navigator.clipboard.writeText(blocked.clabe);
      setCopied(true);
      toast.success("CLABE copiada");
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error("No se pudo copiar la CLABE");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--aula-bg)] px-4 py-10">
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-[var(--aula-text)]">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
          <AlertTriangle size={24} />
        </div>
        <h2 className="mt-4 text-2xl font-semibold">
          {blocked.blockType === "missingContact"
            ? "No pudimos validar tus pagos"
            : "Acceso bloqueado por pagos vencidos"}
        </h2>
        <p className="mt-2 text-[var(--aula-text-muted)]">{blocked.reason}</p>

        {typeof blocked.amount === "number" && blocked.amount > 0 && (
          <p className="mt-4 text-lg font-semibold">
            Total vencido: <span className="text-amber-400">{formatCurrency(blocked.amount)}</span>
          </p>
        )}

        {blocked.overdueRows?.length ? (
          <div className="mt-6 overflow-x-auto rounded-xl border border-[var(--aula-border)]">
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-[var(--aula-text-muted)]">
                <tr>
                  <th className="px-4 py-2 font-medium">Concepto</th>
                  <th className="px-4 py-2 font-medium">Venció</th>
                  <th className="px-4 py-2 font-medium text-right">Monto</th>
                </tr>
              </thead>
              <tbody>
                {blocked.overdueRows.map((row, index) => (
                  <tr key={`${row.concept}-${index}`} className="border-t border-[var(--aula-border)]">
                    <td className="px-4 py-2">{row.concept}</td>
                    <td className="px-4 py-2 text-[var(--aula-text-muted)]">{row.dueDate ?? "—"}</td>
                    <td className="px-4 py-2 text-right">
                      {typeof row.amount === "number" ? formatCurrency(row.amount) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {blocked.clabe && (
          <div className="mt-6 rounded-xl border border-[var(--aula-border)] bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-[var(--aula-text-muted)]">
              {blocked.bank ? `Pago por transferencia · ${blocked.bank}` : "Pago por transferencia"}
            </p>
            <div className="mt-2 flex items-center justify-between gap-3">
              <code className="text-lg tracking-wider">{blocked.clabe}</code>
              <button
                type="button"
                onClick={copyClabe}
                className="flex items-center gap-2 rounded-lg bg-[var(--aula-accent)] px-3 py-2 text-sm font-medium text-white"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "Copiada" : "Copiar"}
              </button>
            </div>
          </div>
        )}

        <a
          href={BILLING_SUPPORT_WHATSAPP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex rounded-lg border border-[var(--aula-border)] px-4 py-2 text-sm font-medium hover:bg-white/5"
        >
          Contactar a administración
        </a>
      </div>
    </div>
  );
}
