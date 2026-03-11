import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firestore";
import {
  buildAgreementLookupPhones,
  isDateKeyInRange,
} from "@/lib/finance/payment-agreements-utils";

export type PaymentAgreementStatus = "active" | "cancelled";

export type PaymentAgreement = {
  id: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentPhone?: string;
  reason: string;
  startDate: string;
  endDate: string;
  status: PaymentAgreementStatus;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
  cancelledAt?: Date;
};

type CreatePaymentAgreementInput = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentPhone?: string | null;
  reason: string;
  startDate: string;
  endDate: string;
  createdBy: string;
};

const toDateOrUndefined = (value: unknown): Date | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (!("toDate" in value)) return undefined;
  const toDate = (value as { toDate?: () => Date }).toDate;
  if (typeof toDate !== "function") return undefined;
  try {
    return toDate();
  } catch {
    return undefined;
  }
};

const toText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const toPaymentAgreement = (
  id: string,
  data: Record<string, unknown>,
): PaymentAgreement => ({
  id,
  studentId: toText(data.studentId),
  studentName: toText(data.studentName),
  studentEmail: toText(data.studentEmail),
  studentPhone: toText(data.studentPhone) || undefined,
  reason: toText(data.reason),
  startDate: toText(data.startDate),
  endDate: toText(data.endDate),
  status: data.status === "cancelled" ? "cancelled" : "active",
  createdBy: toText(data.createdBy) || undefined,
  updatedBy: toText(data.updatedBy) || undefined,
  createdAt: toDateOrUndefined(data.createdAt),
  updatedAt: toDateOrUndefined(data.updatedAt),
  cancelledAt: toDateOrUndefined(data.cancelledAt),
});

export const isAgreementActiveOnDate = (
  agreement: Pick<PaymentAgreement, "status" | "startDate" | "endDate">,
  dateKey: string,
): boolean =>
  agreement.status === "active" &&
  isDateKeyInRange(dateKey, agreement.startDate, agreement.endDate);

export async function getPaymentAgreements(
  maxResults: number = 200,
): Promise<PaymentAgreement[]> {
  const constraints = [orderBy("createdAt", "desc"), limit(maxResults)];
  const snap = await getDocs(query(collection(db, "paymentAgreements"), ...constraints));
  return snap.docs.map((docSnap) =>
    toPaymentAgreement(docSnap.id, docSnap.data() as Record<string, unknown>),
  );
}

export async function getActivePaymentAgreementsByStudent(
  studentId: string,
): Promise<PaymentAgreement[]> {
  const normalizedStudentId = toText(studentId);
  if (!normalizedStudentId) return [];
  const q = query(
    collection(db, "paymentAgreements"),
    where("studentId", "==", normalizedStudentId),
    where("status", "==", "active"),
    orderBy("createdAt", "desc"),
    limit(100),
  );
  const snap = await getDocs(q);
  return snap.docs.map((docSnap) =>
    toPaymentAgreement(docSnap.id, docSnap.data() as Record<string, unknown>),
  );
}

export async function createPaymentAgreement(
  input: CreatePaymentAgreementInput,
): Promise<string> {
  const studentId = toText(input.studentId);
  const studentName = toText(input.studentName);
  const studentEmail = toText(input.studentEmail);
  const reason = toText(input.reason);
  const startDate = toText(input.startDate);
  const endDate = toText(input.endDate);
  const createdBy = toText(input.createdBy);
  const studentPhone = toText(input.studentPhone);

  if (!studentId) throw new Error("studentId es requerido");
  if (!studentName) throw new Error("studentName es requerido");
  if (!studentEmail) throw new Error("studentEmail es requerido");
  if (!reason) throw new Error("El motivo del convenio es requerido");
  if (!startDate) throw new Error("La fecha de inicio es requerida");
  if (!endDate) throw new Error("La fecha de fin es requerida");
  if (startDate > endDate) throw new Error("La fecha de inicio no puede ser mayor a la fecha fin");
  if (!createdBy) throw new Error("createdBy es requerido");

  const agreementRef = await addDoc(collection(db, "paymentAgreements"), {
    studentId,
    studentName,
    studentEmail,
    studentEmailNormalized: studentEmail.toLowerCase(),
    studentPhone: studentPhone || null,
    lookupPhones: buildAgreementLookupPhones([studentPhone]),
    reason,
    startDate,
    endDate,
    status: "active",
    createdBy,
    updatedBy: createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return agreementRef.id;
}

export async function cancelPaymentAgreement(params: {
  agreementId: string;
  cancelledBy: string;
}): Promise<void> {
  const agreementId = toText(params.agreementId);
  const cancelledBy = toText(params.cancelledBy);
  if (!agreementId) throw new Error("agreementId es requerido");
  if (!cancelledBy) throw new Error("cancelledBy es requerido");

  await updateDoc(doc(db, "paymentAgreements", agreementId), {
    status: "cancelled",
    updatedBy: cancelledBy,
    cancelledBy,
    cancelledAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

