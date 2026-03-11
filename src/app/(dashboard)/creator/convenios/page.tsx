"use client";

import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import {
  PaymentAgreement,
  cancelPaymentAgreement,
  createPaymentAgreement,
  getPaymentAgreements,
  isAgreementActiveOnDate,
} from "@/lib/firebase/payment-agreements-service";
import { StudentUser, getStudentUsers } from "@/lib/firebase/students-service";
import { getTodayDateKeyMonterrey } from "@/lib/finance/payment-agreements-utils";
import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";

const toLocalDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const addDays = (baseDateKey: string, days: number): string => {
  if (!baseDateKey) return baseDateKey;
  const [year, month, day] = baseDateKey.split("-").map((part) => Number(part));
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + days);
  return toLocalDateKey(next);
};

const formatDate = (value?: Date): string => {
  if (!value) return "Sin fecha";
  return value.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDateKeyLabel = (value: string): string => {
  if (!value) return "Sin fecha";
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return value;
  return `${day}/${month}/${year}`;
};

type AgreementStatusView = "active" | "scheduled" | "expired" | "cancelled";

const getAgreementStatusView = (
  agreement: PaymentAgreement,
  todayDateKey: string,
): AgreementStatusView => {
  if (agreement.status === "cancelled") return "cancelled";
  if (agreement.startDate > todayDateKey) return "scheduled";
  if (agreement.endDate < todayDateKey) return "expired";
  return "active";
};

const AGREEMENT_STATUS_STYLES: Record<
  AgreementStatusView,
  { label: string; className: string }
> = {
  active: {
    label: "Vigente",
    className: "bg-emerald-100 text-emerald-700",
  },
  scheduled: {
    label: "Programado",
    className: "bg-blue-100 text-blue-700",
  },
  expired: {
    label: "Expirado",
    className: "bg-amber-100 text-amber-700",
  },
  cancelled: {
    label: "Cancelado",
    className: "bg-slate-200 text-slate-700",
  },
};

export default function ConveniosPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [students, setStudents] = useState<StudentUser[]>([]);
  const [agreements, setAgreements] = useState<PaymentAgreement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [searchStudent, setSearchStudent] = useState("");
  const [searchAgreement, setSearchAgreement] = useState("");

  const todayDateKey = getTodayDateKeyMonterrey();
  const [selectedStudentId, setSelectedStudentId] = useState("");
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState(todayDateKey);
  const [endDate, setEndDate] = useState(addDays(todayDateKey, 7));

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsub();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [studentsData, agreementsData] = await Promise.all([
        getStudentUsers(500),
        getPaymentAgreements(300),
      ]);
      setStudents(studentsData);
      setAgreements(agreementsData);
      if (!selectedStudentId && studentsData.length > 0) {
        setSelectedStudentId(studentsData[0].id);
      }
    } catch (error) {
      console.error(error);
      toast.error("No se pudieron cargar los convenios");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredStudents = useMemo(() => {
    const term = searchStudent.trim().toLowerCase();
    if (!term) return students;
    return students.filter((student) => {
      const searchable = `${student.name} ${student.email} ${student.program ?? ""}`.toLowerCase();
      return searchable.includes(term);
    });
  }, [searchStudent, students]);

  const selectedStudent = useMemo(
    () => students.find((student) => student.id === selectedStudentId) ?? null,
    [selectedStudentId, students],
  );

  const filteredAgreements = useMemo(() => {
    const term = searchAgreement.trim().toLowerCase();
    if (!term) return agreements;
    return agreements.filter((agreement) => {
      const searchable = [
        agreement.studentName,
        agreement.studentEmail,
        agreement.reason,
        agreement.startDate,
        agreement.endDate,
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(term);
    });
  }, [agreements, searchAgreement]);

  const activeCount = useMemo(
    () =>
      agreements.filter((agreement) =>
        isAgreementActiveOnDate(agreement, todayDateKey),
      ).length,
    [agreements, todayDateKey],
  );

  const resetCreateForm = () => {
    setCreateStep(1);
    setSearchStudent("");
    setReason("");
    setStartDate(todayDateKey);
    setEndDate(addDays(todayDateKey, 7));
    if (students.length > 0) {
      setSelectedStudentId(students[0].id);
    } else {
      setSelectedStudentId("");
    }
  };

  const openCreateModal = () => {
    if (students.length === 0) {
      toast.error("No hay alumnos disponibles para crear un convenio.");
      return;
    }
    resetCreateForm();
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (saving) return;
    setCreateModalOpen(false);
    setCreateStep(1);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentUser?.uid) {
      toast.error("No se pudo validar tu sesión.");
      return;
    }
    if (!selectedStudent) {
      toast.error("Selecciona un alumno.");
      return;
    }
    if (!reason.trim()) {
      toast.error("Describe claramente el motivo del convenio.");
      return;
    }
    if (reason.trim().length < 10) {
      toast.error("El motivo debe tener al menos 10 caracteres.");
      return;
    }
    if (!startDate || !endDate) {
      toast.error("Selecciona fecha inicio y fin.");
      return;
    }
    if (startDate > endDate) {
      toast.error("La fecha inicio no puede ser mayor a la fecha fin.");
      return;
    }

    setSaving(true);
    try {
      const trimmedReason = reason.trim();
      await createPaymentAgreement({
        studentId: selectedStudent.id,
        studentName: selectedStudent.name,
        studentEmail: selectedStudent.email,
        studentPhone: selectedStudent.phone ?? "",
        reason: trimmedReason,
        startDate,
        endDate,
        createdBy: currentUser.uid,
      });
      toast.success("Convenio creado");
      setCreateModalOpen(false);
      resetCreateForm();
      await loadData();
    } catch (error) {
      console.error(error);
      toast.error(
        error instanceof Error ? error.message : "No se pudo crear el convenio",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCancelAgreement = async (agreement: PaymentAgreement) => {
    if (!currentUser?.uid) {
      toast.error("No se pudo validar tu sesión.");
      return;
    }
    if (agreement.status === "cancelled") return;
    if (!window.confirm(`¿Cancelar el convenio de ${agreement.studentName}?`)) {
      return;
    }
    setCancellingId(agreement.id);
    try {
      await cancelPaymentAgreement({
        agreementId: agreement.id,
        cancelledBy: currentUser.uid,
      });
      toast.success("Convenio cancelado");
      await loadData();
    } catch (error) {
      console.error(error);
      toast.error("No se pudo cancelar el convenio");
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <RoleGate allowedRole={["adminTeacher"]}>
      <div className="space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
              Control escolar
            </p>
            <h1 className="text-2xl font-semibold text-slate-900">
              Convenios de pago
            </h1>
            <p className="text-sm text-slate-600">
              Crea prórrogas por alumno para permitir acceso temporal aunque exista adeudo.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
          >
            + Nuevo convenio
          </button>
        </header>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-500">Total convenios</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{agreements.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-500">Vigentes hoy</p>
            <p className="mt-1 text-2xl font-semibold text-emerald-700">{activeCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs uppercase tracking-[0.15em] text-slate-500">Fecha de control</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">
              {formatDateKeyLabel(todayDateKey)}
            </p>
          </div>
        </div>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Historial de convenios</h2>
            <input
              type="text"
              value={searchAgreement}
              onChange={(event) => setSearchAgreement(event.target.value)}
              placeholder="Buscar convenio..."
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 sm:w-72 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {loading ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
              Cargando convenios...
            </p>
          ) : filteredAgreements.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
              No hay convenios registrados.
            </p>
          ) : (
            <div className="space-y-2">
              {filteredAgreements.map((agreement) => {
                const statusView = getAgreementStatusView(agreement, todayDateKey);
                const statusStyle = AGREEMENT_STATUS_STYLES[statusView];
                return (
                  <article
                    key={agreement.id}
                    className="rounded-lg border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-slate-900">
                          {agreement.studentName}
                        </p>
                        <p className="text-xs text-slate-600">{agreement.studentEmail}</p>
                        <p className="text-sm text-slate-700">{agreement.reason}</p>
                        <p className="text-xs text-slate-500">
                          Vigencia: {formatDateKeyLabel(agreement.startDate)} -{" "}
                          {formatDateKeyLabel(agreement.endDate)}
                        </p>
                        <p className="text-xs text-slate-500">
                          Creado: {formatDate(agreement.createdAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyle.className}`}
                        >
                          {statusStyle.label}
                        </span>
                        {agreement.status !== "cancelled" ? (
                          <button
                            type="button"
                            onClick={() => handleCancelAgreement(agreement)}
                            disabled={cancellingId === agreement.id}
                            className="rounded-lg border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:border-red-400 disabled:cursor-not-allowed disabled:border-red-100 disabled:text-red-300"
                          >
                            {cancellingId === agreement.id ? "Cancelando..." : "Cancelar"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {createModalOpen ? (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-6">
            <div className="w-full max-w-3xl rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Convenios
                  </p>
                  <h2 className="text-lg font-semibold text-slate-900">
                    Crear convenio de pago
                  </h2>
                  <p className="text-sm text-slate-600">
                    Paso {createStep} de 2
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeCreateModal}
                  disabled={saving}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cerrar
                </button>
              </div>

              <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-blue-600 transition-all"
                  style={{ width: createStep === 1 ? "50%" : "100%" }}
                />
              </div>

              {createStep === 1 ? (
                <div className="mt-5 space-y-4">
                  <label className="block text-sm font-medium text-slate-800">
                    Buscar alumno
                    <input
                      type="text"
                      value={searchStudent}
                      onChange={(event) => setSearchStudent(event.target.value)}
                      placeholder="Nombre, correo o programa"
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </label>

                  <div className="max-h-72 overflow-auto rounded-lg border border-slate-200">
                    {filteredStudents.length === 0 ? (
                      <p className="p-3 text-sm text-slate-600">
                        No hay alumnos con ese criterio.
                      </p>
                    ) : (
                      <ul className="divide-y divide-slate-200">
                        {filteredStudents.map((student) => {
                          const isSelected = selectedStudentId === student.id;
                          return (
                            <li
                              key={student.id}
                              className={`cursor-pointer px-3 py-2 text-sm transition ${
                                isSelected ? "bg-blue-50" : "hover:bg-slate-50"
                              }`}
                              onClick={() => setSelectedStudentId(student.id)}
                            >
                              <p className="font-semibold text-slate-900">{student.name}</p>
                              <p className="text-xs text-slate-600">{student.email}</p>
                              {student.program ? (
                                <p className="text-xs text-slate-500">{student.program}</p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {selectedStudent ? (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                      Alumno seleccionado:{" "}
                      <span className="font-semibold">{selectedStudent.name}</span>
                      {" • "}
                      {selectedStudent.email}
                    </div>
                  ) : null}

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeCreateModal}
                      className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreateStep(2)}
                      disabled={!selectedStudent}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Siguiente
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreate} className="mt-5 space-y-4">
                  {selectedStudent ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      Alumno:{" "}
                      <span className="font-semibold text-slate-800">
                        {selectedStudent.name}
                      </span>
                      {" • "}
                      {selectedStudent.email}
                    </div>
                  ) : null}

                  <label className="block text-sm font-medium text-slate-800">
                    Motivo del convenio
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Explica el motivo de la prórroga de pago para este alumno."
                      rows={4}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm font-medium text-slate-800">
                      Fecha inicio
                      <input
                        type="date"
                        value={startDate}
                        onChange={(event) => setStartDate(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </label>
                    <label className="text-sm font-medium text-slate-800">
                      Fecha fin
                      <input
                        type="date"
                        value={endDate}
                        min={startDate || undefined}
                        onChange={(event) => setEndDate(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </label>
                  </div>

                  <p className="text-xs text-slate-500">
                    Vigencia: {formatDateKeyLabel(startDate)} a {formatDateKeyLabel(endDate)}
                  </p>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setCreateStep(1)}
                      disabled={saving}
                      className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Anterior
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-70"
                    >
                      {saving ? "Guardando..." : "Crear convenio"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </RoleGate>
  );
}
