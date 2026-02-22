"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import toast from "react-hot-toast";
import { Copy, Download, KeyRound, RefreshCw, ShieldX } from "lucide-react";
import { auth } from "@/lib/firebase/client";
import { RoleGate } from "@/components/auth/RoleGate";

type ApiKeyItem = {
  id: string;
  name: string;
  scope: string;
  prefix: string;
  status: "active" | "revoked" | "expired";
  createdAt: string | null;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  lastUsedAt: string | null;
};

type ApiKeysResponse = {
  success: boolean;
  data?: ApiKeyItem[];
  error?: string;
};

type CreatedApiKey = {
  id: string;
  name: string;
  scope: string;
  prefix: string;
  expiresAt: string | null;
  createdAt: string;
  apiKey: string;
};

type CreateApiKeyResponse = {
  success: boolean;
  data?: CreatedApiKey;
  error?: string;
};

function formatDate(value: string | null): string {
  if (!value) return "N/D";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/D";
  return date.toLocaleString();
}

function getStatusLabel(status: ApiKeyItem["status"]): string {
  if (status === "active") return "Activa";
  if (status === "expired") return "Expirada";
  return "Revocada";
}

function getStatusClassName(status: ApiKeyItem["status"]): string {
  if (status === "active") return "bg-emerald-100 text-emerald-700";
  if (status === "expired") return "bg-amber-100 text-amber-700";
  return "bg-rose-100 text-rose-700";
}

async function extractApiError(resp: Response, fallback: string): Promise<string> {
  const data = (await resp.json().catch(() => ({}))) as { error?: string };
  return data.error?.trim() || fallback;
}

function mergeAuthHeaders(token: string, headers?: HeadersInit): Headers {
  const merged = new Headers(headers ?? {});
  merged.set("Authorization", `Bearer ${token}`);
  return merged;
}

export default function ApiManagementPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [docsPreview, setDocsPreview] = useState("");
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);
  const [formName, setFormName] = useState("");
  const [formScope, setFormScope] = useState("platform.*");
  const [formExpiryDays, setFormExpiryDays] = useState(0);

  const sortedKeys = useMemo(
    () =>
      [...keys].sort((a, b) => {
        const left = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const right = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return right - left;
      }),
    [keys],
  );

  const fetchWithToken = useCallback(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (!currentUser) {
        throw new Error("No hay sesión activa");
      }
      const token = await currentUser.getIdToken();
      return fetch(url, {
        ...init,
        headers: mergeAuthHeaders(token, init?.headers),
      });
    },
    [currentUser],
  );

  const loadKeys = useCallback(
    async (isRefresh = false) => {
      if (!currentUser) return;
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const response = await fetchWithToken("/api/admin/api-keys");
        if (!response.ok) {
          const error = await extractApiError(response, "No se pudieron cargar las API keys");
          throw new Error(error);
        }
        const payload = (await response.json()) as ApiKeysResponse;
        setKeys(payload.data ?? []);
      } catch (error: unknown) {
        const message =
          (error as { message?: string }).message || "No se pudieron cargar las API keys";
        toast.error(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [currentUser, fetchWithToken],
  );

  const loadDocsPreview = useCallback(async () => {
    if (!currentUser) return;
    setLoadingDocs(true);
    try {
      const response = await fetchWithToken("/api/admin/api-docs?format=md");
      if (!response.ok) {
        const error = await extractApiError(response, "No se pudo cargar la guía API");
        throw new Error(error);
      }
      const text = await response.text();
      setDocsPreview(text);
    } catch (error: unknown) {
      const message = (error as { message?: string }).message || "No se pudo cargar la guía API";
      toast.error(message);
    } finally {
      setLoadingDocs(false);
    }
  }, [currentUser, fetchWithToken]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    void loadKeys(false);
    void loadDocsPreview();
  }, [currentUser, loadDocsPreview, loadKeys]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = formName.trim();
    const scope = formScope.trim().toLowerCase();
    if (!name) {
      toast.error("Ingresa un nombre para la API key");
      return;
    }
    if (!scope) {
      toast.error("Ingresa un scope válido");
      return;
    }
    setCreating(true);
    try {
      const response = await fetchWithToken("/api/admin/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          scope,
          expiresInDays: formExpiryDays,
        }),
      });
      if (!response.ok) {
        const error = await extractApiError(response, "No se pudo crear la API key");
        throw new Error(error);
      }
      const payload = (await response.json()) as CreateApiKeyResponse;
      if (!payload.success || !payload.data) {
        throw new Error(payload.error || "No se pudo crear la API key");
      }
      setCreatedKey(payload.data);
      setFormName("");
      setFormScope("platform.*");
      setFormExpiryDays(0);
      toast.success("API key creada");
      await loadKeys(true);
    } catch (error: unknown) {
      const message = (error as { message?: string }).message || "No se pudo crear la API key";
      toast.error(message);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ApiKeyItem) => {
    if (key.status !== "active") return;
    const confirmed = window.confirm(`¿Revocar la API key "${key.name}"?`);
    if (!confirmed) return;

    setRevokingId(key.id);
    try {
      const response = await fetchWithToken(`/api/admin/api-keys/${key.id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Revocada desde panel adminTeacher" }),
      });
      if (!response.ok) {
        const error = await extractApiError(response, "No se pudo revocar la API key");
        throw new Error(error);
      }
      toast.success("API key revocada");
      await loadKeys(true);
    } catch (error: unknown) {
      const message = (error as { message?: string }).message || "No se pudo revocar la API key";
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  };

  const copyCreatedKey = async () => {
    if (!createdKey?.apiKey) return;
    try {
      await navigator.clipboard.writeText(createdKey.apiKey);
      toast.success("API key copiada");
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  };

  const downloadGuide = async (format: "md" | "txt") => {
    try {
      const response = await fetchWithToken(`/api/admin/api-docs?format=${format}&download=1`);
      if (!response.ok) {
        const error = await extractApiError(response, "No se pudo descargar la guía");
        throw new Error(error);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `udelx-api-guide.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast.success("Guía descargada");
    } catch (error: unknown) {
      const message = (error as { message?: string }).message || "No se pudo descargar la guía";
      toast.error(message);
    }
  };

  return (
    <RoleGate allowedRole="adminTeacher">
      <div className="space-y-6 text-slate-900">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Integraciones</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">API & Webhooks</h1>
              <p className="text-sm text-slate-600">
                Gestiona llaves rotables, revócalas y comparte documentación técnica con terceros.
              </p>
            </div>
            <button
              type="button"
              onClick={() => loadKeys(true)}
              disabled={refreshing || loading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-blue-500 hover:text-blue-700 disabled:opacity-70"
            >
              <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              {refreshing ? "Actualizando..." : "Actualizar"}
            </button>
          </div>
        </header>

        {createdKey ? (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-emerald-800">Llave generada (solo visible ahora)</p>
                <p className="text-xs text-emerald-700">
                  Guarda esta llave en el sistema externo. Después solo verás su prefijo.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCreatedKey(null)}
                className="rounded-lg border border-emerald-300 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                Ocultar
              </button>
            </div>
            <div className="mt-3 rounded-lg border border-emerald-200 bg-white p-3">
              <p className="break-all font-mono text-sm text-slate-900">{createdKey.apiKey}</p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={copyCreatedKey}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600"
              >
                <Copy size={14} />
                Copiar API key
              </button>
            </div>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Crear nueva API key</h2>
          <p className="mt-1 text-sm text-slate-600">
            Recomendado: una llave por integración para revocación y trazabilidad selectiva.
          </p>
          <form onSubmit={handleCreate} className="mt-4 grid gap-3 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
            <div>
              <label className="text-sm font-medium text-slate-800">Nombre</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="POS Universidad - Producción"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-800">Scope</label>
              <input
                value={formScope}
                onChange={(e) => setFormScope(e.target.value)}
                placeholder="platform.*"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-800">Expira (días)</label>
              <input
                type="number"
                min={0}
                max={365}
                value={formExpiryDays}
                onChange={(e) => setFormExpiryDays(Number(e.target.value) || 0)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-slate-500">Usa 0 para no expirar.</p>
            </div>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:opacity-70"
            >
              <KeyRound size={16} />
              {creating ? "Creando..." : "Crear llave"}
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Llaves registradas</h2>
            <span className="text-xs text-slate-500">{sortedKeys.length} total</span>
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-slate-600">Cargando llaves...</p>
          ) : sortedKeys.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">No hay API keys creadas todavía.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Nombre</th>
                    <th className="px-3 py-2 font-semibold">Scope</th>
                    <th className="px-3 py-2 font-semibold">Prefijo</th>
                    <th className="px-3 py-2 font-semibold">Estado</th>
                    <th className="px-3 py-2 font-semibold">Creada</th>
                    <th className="px-3 py-2 font-semibold">Expira</th>
                    <th className="px-3 py-2 font-semibold">Último uso</th>
                    <th className="px-3 py-2 font-semibold text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sortedKeys.map((key) => (
                    <tr key={key.id}>
                      <td className="px-3 py-3">
                        <p className="font-medium text-slate-900">{key.name}</p>
                        <p className="text-xs text-slate-500">id: {key.id}</p>
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-700">{key.scope}</td>
                      <td className="px-3 py-3 font-mono text-xs text-slate-700">{key.prefix}</td>
                      <td className="px-3 py-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${getStatusClassName(key.status)}`}
                        >
                          {getStatusLabel(key.status)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-700">{formatDate(key.createdAt)}</td>
                      <td className="px-3 py-3 text-xs text-slate-700">{formatDate(key.expiresAt)}</td>
                      <td className="px-3 py-3 text-xs text-slate-700">{formatDate(key.lastUsedAt)}</td>
                      <td className="px-3 py-3 text-right">
                        <button
                          type="button"
                          disabled={key.status !== "active" || revokingId === key.id}
                          onClick={() => handleRevoke(key)}
                          className="inline-flex items-center gap-1 rounded-md border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-700 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <ShieldX size={14} />
                          {revokingId === key.id ? "Revocando..." : "Revocar"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Guía API para desarrolladores</h2>
              <p className="text-sm text-slate-600">
                Incluye autenticación, payload recomendado, respuestas y prácticas de rotación.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => downloadGuide("md")}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-500 hover:text-blue-700"
              >
                <Download size={14} />
                Descargar .md
              </button>
              <button
                type="button"
                onClick={() => downloadGuide("txt")}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-blue-500 hover:text-blue-700"
              >
                <Download size={14} />
                Descargar .txt
              </button>
            </div>
          </div>
          <div className="mt-3 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
            {loadingDocs ? (
              <p className="text-sm text-slate-600">Cargando guía...</p>
            ) : (
              <pre className="whitespace-pre-wrap text-xs leading-5 text-slate-700">{docsPreview}</pre>
            )}
          </div>
        </section>
      </div>
    </RoleGate>
  );
}
