import { doc, getDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "@/lib/firebase/firestore";
import type { BillingBlockedState, FinanceStatus, FinanceValidationDailyCache } from "./types";

const FINANCE_STATUS_ENDPOINT = "/api/finance/customer-status";
const FINANCE_VALIDATION_TIMEZONE = "America/Monterrey";

export const BILLING_SUPPORT_WHATSAPP_URL = `https://wa.me/527821012431?text=${encodeURIComponent(
  "Hola, me aparece bloqueo por pagos vencidos en la plataforma UDEL y necesito ayuda para revisar mi acceso.",
)}`;

/** Misma clave de caché que el feed clásico: un bloqueo vale para ambas interfaces. */
const financeValidationCacheKey = (uid: string) => `financeValidationDaily:${uid}`;

const normalizePhone = (raw?: string | null) => {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const currencyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 2,
});

export const formatCurrency = (value?: number | null) =>
  currencyFormatter.format(typeof value === "number" && Number.isFinite(value) ? value : 0);

const parseAmountFromText = (raw?: string) => {
  if (!raw) return undefined;
  const normalized = raw.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!normalized) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
};

const parseOverdueRowsFromText = (raw: string) =>
  raw
    .split("|")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk
        .split("•")
        .map((p) => p.trim())
        .filter(Boolean);
      const dueToken = parts.find((p) => /^venci[oó]:/i.test(p));
      const amountToken = [...parts].reverse().find((p) => p.includes("$"));
      return {
        campus: "Sin plantel",
        concept: parts[0] || "Pago pendiente",
        dueDate: dueToken ? dueToken.replace(/^venci[oó]:/i, "").trim() : undefined,
        amount: parseAmountFromText(amountToken),
      };
    });

const getCurrentDateKeyInMonterrey = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: FINANCE_VALIDATION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const loadFinanceValidationCache = (uid: string): FinanceValidationDailyCache | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(financeValidationCacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FinanceValidationDailyCache>;
    if (
      parsed?.version !== 1 ||
      typeof parsed.dateKey !== "string" ||
      typeof parsed.checkedAt !== "string" ||
      typeof parsed.phone !== "string" ||
      typeof parsed.whatsapp !== "string" ||
      typeof parsed.email !== "string"
    ) {
      return null;
    }
    if (!["ok", "blocked", "missingContact"].includes(parsed.status ?? "")) return null;
    return parsed as FinanceValidationDailyCache;
  } catch {
    return null;
  }
};

const saveFinanceValidationCache = (uid: string, data: FinanceValidationDailyCache) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(financeValidationCacheKey(uid), JSON.stringify(data));
  } catch {
    // Ignorar fallos de almacenamiento local.
  }
};

const MISSING_CONTACT_REASON =
  "No hay teléfono o WhatsApp registrado para validar tus pagos. Contacta a administración.";
const OVERDUE_REASON = "Tienes pagos vencidos. Regulariza tu cuenta para continuar.";

export type BillingCheckResult =
  | { status: "ok" }
  | { status: "blocked"; blocked: BillingBlockedState }
  | { status: "error"; message: string };

/**
 * Port de la validación financiera del feed clásico (mismo endpoint, misma caché
 * diaria por zona horaria de Monterrey, mismos criterios de adeudo).
 */
export const validateBillingStatus = async (currentUser: User): Promise<BillingCheckResult> => {
  try {
    const userSnap = await getDoc(doc(db, "users", currentUser.uid));
    const userData = userSnap.data() ?? {};
    const phone = normalizePhone(userData.phone ?? currentUser.phoneNumber ?? "");
    const financeEmail =
      (typeof userData.email === "string" && userData.email.trim()
        ? userData.email.trim().toLowerCase()
        : currentUser.email?.trim().toLowerCase()) || "";
    const whatsapp = normalizePhone(
      userData.whatsapp ??
        userData.WhatsApp ??
        userData.whatsApp ??
        userData.whatsappPhone ??
        userData.whatsappNumber ??
        "",
    );

    const dateKey = getCurrentDateKeyInMonterrey();
    const cache = loadFinanceValidationCache(currentUser.uid);
    const cacheStillValid =
      cache?.dateKey === dateKey &&
      cache.phone === phone &&
      cache.whatsapp === whatsapp &&
      cache.email === financeEmail;

    if (cacheStillValid) {
      if (cache.status === "ok") return { status: "ok" };
      const fallback: BillingBlockedState =
        cache.status === "missingContact"
          ? { blockType: "missingContact", reason: MISSING_CONTACT_REASON }
          : { blockType: "overdue", reason: OVERDUE_REASON };
      return { status: "blocked", blocked: cache.blocked ?? fallback };
    }

    if (!phone && !whatsapp) {
      const blocked: BillingBlockedState = {
        blockType: "missingContact",
        reason: MISSING_CONTACT_REASON,
      };
      saveFinanceValidationCache(currentUser.uid, {
        version: 1,
        dateKey,
        checkedAt: new Date().toISOString(),
        phone,
        whatsapp,
        email: financeEmail,
        status: "missingContact",
        blocked,
      });
      return { status: "blocked", blocked };
    }

    const financeQuery = new URLSearchParams();
    if (phone) financeQuery.set("phone", phone);
    if (whatsapp) financeQuery.set("whatsapp", whatsapp);
    if (financeEmail) financeQuery.set("email", financeEmail);

    const response = await fetch(`${FINANCE_STATUS_ENDPOINT}?${financeQuery.toString()}`, {
      cache: "no-store",
    });
    const payload: FinanceStatus = await response.json().catch(() => ({ success: false }));

    if (!response.ok || !payload?.success || !payload?.data) {
      return {
        status: "error",
        message: "No se pudo validar tu estado de pagos. Intenta nuevamente en unos minutos.",
      };
    }

    const overdue =
      payload.data.hasOverduePayments ||
      (payload.data.totalOverdueAmount ?? 0) > 0 ||
      (payload.data.overdueCount ?? 0) > 0 ||
      (payload.data.overduePaymentsCount ?? 0) > 0 ||
      (payload.data.overdueReceivablesCount ?? 0) > 0;
    const hasActivePaymentAgreement =
      payload.data.hasActivePaymentAgreement === true &&
      payload.data.accessGrantedByAgreement !== false;

    if (overdue && !hasActivePaymentAgreement) {
      const overdueSource = payload.data.overdueDetails;
      let overdueRows: BillingBlockedState["overdueRows"] = [];

      if (Array.isArray(overdueSource)) {
        overdueRows = overdueSource.map((d) => ({
          campus: (d.campus ?? "").trim() || undefined,
          concept: (d.concept ?? "").trim() || "Pago pendiente",
          dueDate: d.dueDate,
          amount: typeof d.amount === "number" ? d.amount : undefined,
          daysOverdue: typeof d.daysOverdue === "number" ? d.daysOverdue : undefined,
        }));
      } else {
        const legacyText =
          (typeof overdueSource === "string" ? overdueSource : "") ||
          payload.data.overdueDetailsText ||
          payload.data.details ||
          "";
        if (legacyText) overdueRows = parseOverdueRowsFromText(legacyText);
      }

      const blocked: BillingBlockedState = {
        blockType: "overdue",
        reason: OVERDUE_REASON,
        amount: payload.data.totalOverdueAmount,
        overdueRows: overdueRows.length ? overdueRows : undefined,
        clabe: (payload.data.clabe?.clabe ?? "").trim() || undefined,
        bank: (payload.data.clabe?.bank ?? "").trim() || undefined,
      };
      saveFinanceValidationCache(currentUser.uid, {
        version: 1,
        dateKey,
        checkedAt: new Date().toISOString(),
        phone,
        whatsapp,
        email: financeEmail,
        status: "blocked",
        blocked,
      });
      return { status: "blocked", blocked };
    }

    saveFinanceValidationCache(currentUser.uid, {
      version: 1,
      dateKey,
      checkedAt: new Date().toISOString(),
      phone,
      whatsapp,
      email: financeEmail,
      status: "ok",
    });
    return { status: "ok" };
  } catch (error) {
    console.error("Error validando estado financiero:", error);
    return { status: "error", message: "No se pudo validar tu estado de pagos." };
  }
};
