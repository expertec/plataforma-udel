"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Check, Pencil, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import {
  createPlantel,
  deletePlantel,
  getPlanteles,
  normalizePlantelName,
  Plantel,
  updatePlantel,
} from "@/lib/firebase/planteles-service";

function formatDate(value?: Date | null): string {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(value);
}

export default function PlantelesPage() {
  const [planteles, setPlanteles] = useState<Plantel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filteredPlanteles = useMemo(() => {
    const query = normalizePlantelName(search);
    if (!query) return planteles;
    return planteles.filter((plantel) => plantel.normalizedName.includes(query));
  }, [planteles, search]);

  const loadPlanteles = async () => {
    setLoading(true);
    try {
      const data = await getPlanteles();
      setPlanteles(data);
    } catch (err) {
      console.error("Error cargando planteles:", err);
      toast.error("No se pudieron cargar los planteles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((user) => {
      if (user) {
        void loadPlanteles();
      }
    });
    return () => unsub();
  }, []);

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Escribe el nombre del plantel");
      return;
    }

    const normalizedName = normalizePlantelName(trimmedName);
    const existingPlantel = planteles.find((plantel) => plantel.normalizedName === normalizedName);
    if (existingPlantel) {
      setName("");
      toast.success("El plantel ya existe en el catálogo");
      return;
    }

    setSaving(true);
    try {
      const createdPlantel = await createPlantel(trimmedName);
      setPlanteles((prev) => {
        const withoutDuplicate = prev.filter((plantel) => plantel.id !== createdPlantel.id);
        return [...withoutDuplicate, createdPlantel].sort((a, b) =>
          a.name.localeCompare(b.name, "es"),
        );
      });
      setName("");
      toast.success("Plantel creado");
    } catch (err) {
      console.error("Error creando plantel:", err);
      toast.error("No se pudo crear el plantel");
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (plantel: Plantel) => {
    setEditingId(plantel.id);
    setEditingName(plantel.name);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditingName("");
  };

  const handleUpdate = async (plantel: Plantel) => {
    const trimmedName = editingName.trim();
    if (!trimmedName) {
      toast.error("Escribe el nombre del plantel");
      return;
    }

    const normalizedName = normalizePlantelName(trimmedName);
    const duplicatePlantel = planteles.find(
      (item) => item.id !== plantel.id && item.normalizedName === normalizedName,
    );
    if (duplicatePlantel) {
      toast.error("Ya existe otro plantel con ese nombre");
      return;
    }

    if (plantel.normalizedName === normalizedName && plantel.name === trimmedName) {
      cancelEditing();
      return;
    }

    setUpdatingId(plantel.id);
    try {
      const updatedPlantel = await updatePlantel(plantel.id, trimmedName);
      setPlanteles((prev) =>
        prev
          .map((item) => (item.id === updatedPlantel.id ? updatedPlantel : item))
          .sort((a, b) => a.name.localeCompare(b.name, "es")),
      );
      cancelEditing();
      toast.success("Plantel actualizado");
    } catch (err) {
      console.error("Error actualizando plantel:", err);
      toast.error(err instanceof Error ? err.message : "No se pudo actualizar el plantel");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleDelete = async (plantel: Plantel) => {
    const confirmed = window.confirm(
      `Eliminar "${plantel.name}" del catálogo?\n\nSe quitará este plantel de coordinadores, grupos, alumnos e inscripciones vinculadas.`,
    );
    if (!confirmed) return;

    setDeletingId(plantel.id);
    try {
      await deletePlantel(plantel.id);
      setPlanteles((prev) => prev.filter((item) => item.id !== plantel.id));
      if (editingId === plantel.id) {
        cancelEditing();
      }
      toast.success("Plantel eliminado");
    } catch (err) {
      console.error("Error eliminando plantel:", err);
      toast.error(err instanceof Error ? err.message : "No se pudo eliminar el plantel");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <RoleGate allowedRole={["adminTeacher", "superAdminTeacher"]}>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Catálogo</p>
            <h1 className="text-2xl font-semibold text-slate-900">Planteles</h1>
            <p className="text-sm text-slate-600">
              Crea los planteles que después se asignan a coordinadores y grupos.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar plantel"
                className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-64"
              />
            </div>
            <button
              type="button"
              onClick={loadPlanteles}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-blue-500 hover:text-blue-600 disabled:opacity-60"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              Actualizar
            </button>
          </div>
        </header>

        <form
          onSubmit={handleCreate}
          className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-[1fr_auto] md:items-end"
        >
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Nombre del plantel
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ej. Plantel Monterrey"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              disabled={saving}
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus size={16} />
            {saving ? "Creando..." : "Crear plantel"}
          </button>
        </form>

        <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Planteles registrados</h2>
              <p className="text-sm text-slate-500">
                {filteredPlanteles.length} de {planteles.length} planteles
              </p>
            </div>
          </div>

          {loading ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">Cargando planteles...</div>
          ) : filteredPlanteles.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">
              {planteles.length === 0
                ? "Aún no hay planteles registrados."
                : "No encontramos planteles con esa búsqueda."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {filteredPlanteles.map((plantel) => (
                <article
                  key={plantel.id}
                  className="flex flex-col gap-3 px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                      <Building2 size={20} />
                    </div>
                    <div className="min-w-0">
                      {editingId === plantel.id ? (
                        <input
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-80"
                          disabled={updatingId === plantel.id || deletingId === plantel.id}
                          autoFocus
                        />
                      ) : (
                        <h3 className="font-semibold text-slate-900">{plantel.name}</h3>
                      )}
                      <p className="mt-1 text-sm text-slate-500">
                        Creado: {formatDate(plantel.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 self-start lg:self-center">
                    <span className="w-fit rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      Activo
                    </span>
                    {editingId === plantel.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleUpdate(plantel)}
                          disabled={updatingId === plantel.id || deletingId === plantel.id}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                          title="Guardar cambios"
                        >
                          <Check size={16} />
                          <span className="sr-only">Guardar cambios</span>
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditing}
                          disabled={updatingId === plantel.id || deletingId === plantel.id}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                          title="Cancelar edición"
                        >
                          <X size={16} />
                          <span className="sr-only">Cancelar edición</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEditing(plantel)}
                          disabled={Boolean(updatingId) || deletingId === plantel.id}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-blue-300 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                          title="Editar plantel"
                        >
                          <Pencil size={16} />
                          <span className="sr-only">Editar plantel</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(plantel)}
                          disabled={Boolean(updatingId) || deletingId === plantel.id}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 bg-white text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                          title="Eliminar plantel"
                        >
                          <Trash2 size={16} />
                          <span className="sr-only">Eliminar plantel</span>
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </RoleGate>
  );
}
