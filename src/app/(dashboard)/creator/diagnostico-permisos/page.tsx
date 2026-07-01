"use client";

import { useCallback, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { auth } from "@/lib/firebase/client";
import { PROBE_ROLE_LABELS, PROBE_ROLE_ORDER, type ProbeRole } from "@/lib/rules-probe/constants";
import { runRulesProbe, type ProbeCaseResult } from "@/lib/rules-probe/runner";

type ProbeResponse = {
  success?: boolean;
  error?: string;
  data?: {
    tokens?: Record<string, string>;
    rulesVersion?: string | null;
    generatedAt?: string;
  };
};

const ROLE_ORDER: ProbeRole[] = PROBE_ROLE_ORDER;

export default function DiagnosticoPermisosPage() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ProbeCaseResult[]>([]);
  const [rulesVersion, setRulesVersion] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) {
      toast.error("Inicia sesión para ejecutar el diagnóstico.");
      return;
    }
    setRunning(true);
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/admin/rules-probe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = (await response.json().catch(() => null)) as ProbeResponse | null;
      if (!response.ok || !payload?.success || !payload.data?.tokens) {
        throw new Error(payload?.error || "No se pudo preparar el sandbox de permisos");
      }
      setRulesVersion(payload.data.rulesVersion ?? null);
      const probeResults = await runRulesProbe(payload.data.tokens);
      setResults(probeResults);
      setLastRunAt(new Date().toLocaleString("es-MX"));
      const failing = probeResults.filter((r) => !r.pass).length;
      if (failing === 0) {
        toast.success("Todos los permisos se comportan como se espera.");
      } else {
        toast.error(`${failing} permiso(s) NO coinciden con lo esperado.`);
      }
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Error ejecutando el diagnóstico");
    } finally {
      setRunning(false);
    }
  }, []);

  const summary = useMemo(() => {
    const total = results.length;
    const failing = results.filter((r) => !r.pass).length;
    const errored = results.filter((r) => r.actual === "error").length;
    return { total, failing, ok: total - failing, errored };
  }, [results]);

  const resultsByRole = useMemo(() => {
    const map = new Map<ProbeRole, ProbeCaseResult[]>();
    results.forEach((result) => {
      const list = map.get(result.role) ?? [];
      list.push(result);
      map.set(result.role, list);
    });
    return map;
  }, [results]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
            AdminTeacher
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">Diagnóstico de permisos</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Ejecuta las acciones clave de alumnos y profesores con las reglas reales en vivo y detecta
            si un cambio rompió algo, antes de que falle un usuario real. Usa un sandbox aislado
            (<code className="rounded bg-slate-100 px-1">__rulesProbe__</code>) y no toca datos reales.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void runProbe()}
          disabled={running}
          className="shrink-0 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60"
        >
          {running ? "Ejecutando..." : "Ejecutar diagnóstico"}
        </button>
      </div>

      {results.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryCard label="Pruebas" value={summary.total} tone="slate" />
          <SummaryCard label="Correctas" value={summary.ok} tone="emerald" />
          <SummaryCard label="Regresiones" value={summary.failing - summary.errored} tone="rose" />
          <SummaryCard label="Errores" value={summary.errored} tone="amber" />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-500">
        <span>
          Versión de reglas activa:{" "}
          <span className="font-mono text-slate-700">{rulesVersion ?? "n/d"}</span>
        </span>
        {lastRunAt ? <span>Última corrida: {lastRunAt}</span> : null}
      </div>

      {results.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
          Pulsa “Ejecutar diagnóstico” para correr la matriz de permisos.
        </div>
      ) : (
        <div className="space-y-6">
          {ROLE_ORDER.map((role) => {
            const roleResults = resultsByRole.get(role);
            if (!roleResults || roleResults.length === 0) return null;
            return (
              <div key={role} className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800">
                  {PROBE_ROLE_LABELS[role]}
                </div>
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-500">
                    <tr className="border-t border-slate-100">
                      <th className="px-4 py-2 font-medium">Acción</th>
                      <th className="px-4 py-2 font-medium">Esperado</th>
                      <th className="px-4 py-2 font-medium">Real</th>
                      <th className="px-4 py-2 font-medium">Resultado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {roleResults.map((result) => (
                      <tr key={result.id} className="align-top">
                        <td className="px-4 py-3 text-slate-700">
                          {result.label}
                          {result.errorMessage ? (
                            <div className="mt-1 text-xs text-amber-700">{result.errorMessage}</div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <OutcomeBadge value={result.expected} />
                        </td>
                        <td className="px-4 py-3">
                          <OutcomeBadge value={result.actual} />
                        </td>
                        <td className="px-4 py-3">
                          {result.pass ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                              ✓ OK
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-semibold text-rose-700">
                              ✕ Revisar
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "slate" | "emerald" | "rose" | "amber";
}) {
  const toneClasses: Record<typeof tone, string> = {
    slate: "text-slate-900",
    emerald: "text-emerald-600",
    rose: "text-rose-600",
    amber: "text-amber-600",
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClasses[tone]}`}>{value}</p>
    </div>
  );
}

function OutcomeBadge({ value }: { value: "allow" | "deny" | "error" }) {
  if (value === "allow") {
    return (
      <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
        Permitido
      </span>
    );
  }
  if (value === "deny") {
    return (
      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
        Bloqueado
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
      Error
    </span>
  );
}
