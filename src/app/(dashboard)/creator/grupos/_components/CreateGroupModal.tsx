"use client";

import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { createGroup, Group } from "@/lib/firebase/groups-service";
import { createPlantel, Plantel } from "@/lib/firebase/planteles-service";

type CourseOption = { id: string; title: string };

type Props = {
  open: boolean;
  onClose: () => void;
  courses: CourseOption[];
  planteles: Plantel[];
  defaultPlantelId?: string;
  lockPlantel?: boolean;
  teacherId: string;
  teacherName: string;
  onCreated: (group: Group) => void;
  onPlantelCreated?: (plantel: Plantel) => void;
};

export function CreateGroupModal({
  open,
  onClose,
  courses,
  planteles,
  defaultPlantelId = "",
  lockPlantel = false,
  teacherId,
  teacherName,
  onCreated,
  onPlantelCreated,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedPlantelId, setSelectedPlantelId] = useState(defaultPlantelId);
  const [localPlanteles, setLocalPlanteles] = useState<Plantel[]>(planteles);
  const [groupName, setGroupName] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [saving, setSaving] = useState(false);
  const [newPlantelName, setNewPlantelName] = useState("");
  const [creatingPlantel, setCreatingPlantel] = useState(false);
  const [programOptions, setProgramOptions] = useState([
    "Licenciatura",
    "Preparatoria",
    "Maestría",
  ]);
  const [program, setProgram] = useState(programOptions[0]);
  const [customProgram, setCustomProgram] = useState("");
  const filteredCourses = useMemo(() => {
    const normalized = searchTerm.trim().toLowerCase();
    if (!normalized) return courses;
    return courses.filter((c) => c.title.toLowerCase().includes(normalized));
  }, [courses, searchTerm]);
  const selectedPlantel = useMemo(
    () => localPlanteles.find((plantel) => plantel.id === selectedPlantelId) ?? null,
    [localPlanteles, selectedPlantelId],
  );

  useEffect(() => {
    if (!open) return;
    setLocalPlanteles(planteles);
    setSelectedPlantelId(defaultPlantelId);
  }, [defaultPlantelId, open, planteles]);

  if (!open) return null;

  const handleCreatePlantel = async () => {
    const trimmed = newPlantelName.trim();
    if (!trimmed) {
      toast.error("Escribe el nombre del plantel");
      return;
    }
    setCreatingPlantel(true);
    try {
      const plantel = await createPlantel(trimmed);
      setLocalPlanteles((prev) => {
        if (prev.some((item) => item.id === plantel.id)) return prev;
        return [...prev, plantel].sort((a, b) => a.name.localeCompare(b.name, "es"));
      });
      onPlantelCreated?.(plantel);
      setSelectedPlantelId(plantel.id);
      setNewPlantelName("");
      toast.success("Plantel agregado");
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el plantel");
    } finally {
      setCreatingPlantel(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) {
      toast.error("El nombre del grupo es obligatorio");
      return;
    }
    if (!selectedPlantel) {
      toast.error("Selecciona un plantel");
      return;
    }
    const uniqueIds = Array.from(new Set(selectedIds.filter(Boolean)));
    const coursesPayload = uniqueIds
      .map((id) => {
        const found = courses.find((c) => c.id === id);
        return found ? { courseId: found.id, courseName: found.title } : null;
      })
      .filter(Boolean) as Array<{ courseId: string; courseName: string }>;
    const primaryCourse = coursesPayload[0];

    setSaving(true);
    try {
      const groupId = await createGroup({
        courseId: primaryCourse?.courseId,
        courseName: primaryCourse?.courseName,
        courses: coursesPayload,
        groupName: groupName.trim(),
        teacherId,
        teacherName,
        program,
        plantelId: selectedPlantel.id,
        plantelName: selectedPlantel.name,
        maxStudents: 0,
      });

      onCreated({
        id: groupId,
        courseId: primaryCourse?.courseId ?? "",
        courseName: primaryCourse?.courseName ?? "",
        courses: coursesPayload,
        groupName: groupName.trim(),
        teacherId,
        teacherName,
        semester: "",
        startDate: null,
        endDate: null,
        status: "active",
        studentsCount: 0,
        maxStudents: 0,
        program,
        plantelId: selectedPlantel.id,
        plantelName: selectedPlantel.name,
      });
      toast.success("Grupo creado");
      onClose();
      setGroupName("");
      setSelectedIds([]);
      setSelectedPlantelId(defaultPlantelId);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo crear el grupo");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
      <div className="w-full max-w-lg max-h-[calc(100vh-3rem)] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">Crear Nuevo Grupo</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-slate-500 hover:text-slate-800"
          >
            ✕
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          className="mt-4 space-y-4"
          style={{ maxHeight: "75vh", overflowY: "auto", paddingRight: "0.6rem" }}
        >
          <div>
            <label className="text-sm font-medium text-slate-800">Nombre del grupo</label>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Ej: Grupo A"
              required
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Programa</label>
            <select
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {programOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={customProgram}
                onChange={(e) => setCustomProgram(e.target.value)}
                placeholder="Agregar otro programa"
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => {
                  const trimmed = customProgram.trim();
                  if (!trimmed) return;
                  if (!programOptions.includes(trimmed)) {
                    setProgramOptions((prev) => [...prev, trimmed]);
                  }
                  setProgram(trimmed);
                  setCustomProgram("");
                }}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 transition hover:border-blue-400 hover:text-blue-500"
              >
                Agregar
              </button>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Plantel</label>
            <select
              value={selectedPlantelId}
              onChange={(e) => setSelectedPlantelId(e.target.value)}
              disabled={lockPlantel}
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
              required
            >
              <option value="">Seleccionar plantel</option>
              {localPlanteles.map((plantel) => (
                <option key={plantel.id} value={plantel.id}>
                  {plantel.name}
                </option>
              ))}
            </select>
            {!lockPlantel ? (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={newPlantelName}
                  onChange={(e) => setNewPlantelName(e.target.value)}
                  placeholder="Agregar otro plantel"
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={handleCreatePlantel}
                  disabled={creatingPlantel}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 transition hover:border-blue-400 hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {creatingPlantel ? "Agregando..." : "Agregar"}
                </button>
              </div>
            ) : null}
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">Buscar materia</label>
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Filtrar por título…"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-slate-800">
              Asignar materias al grupo (opcional)
            </label>
            <div className="mt-2 grid max-h-40 grid-cols-1 gap-2 overflow-auto rounded-lg border border-slate-200 p-3">
              {filteredCourses.length === 0 ? (
                <p className="text-xs text-slate-500">No hay materias que coincidan</p>
              ) : (
                filteredCourses.map((c) => {
                  const checked = selectedIds.includes(c.id);
                  return (
                    <label key={c.id} className="flex items-center gap-2 text-sm text-slate-800">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedIds((prev) => Array.from(new Set([...prev, c.id])));
                          } else {
                            setSelectedIds((prev) => prev.filter((id) => id !== c.id));
                          }
                        }}
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span>{c.title}</span>
                    </label>
                  );
                })
              )}
              {courses.length === 0 ? (
                <p className="text-xs text-slate-500">Crea cursos para asignarlos al grupo.</p>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Los alumnos verán las materias asignadas en su feed por curso cuando los profesores agreguen contenidos.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {saving ? "Creando..." : "Crear Grupo"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
