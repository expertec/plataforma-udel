import { NextRequest, NextResponse } from "next/server";

type RemoteOverdueDetail = {
  type?: string;
  concept?: string;
  paymentNumber?: number;
  totalPayments?: number;
  amount?: number;
  dueDate?: string;
  daysOverdue?: number;
};

type RemoteFinanceData = {
  phone?: string;
  whatsapp?: string;
  balance?: number;
  points?: number;
  name?: string;
  email?: string;
  clabe?: {
    clabe?: string;
    bank?: string;
  };
  customer?: {
    phone?: string;
    whatsapp?: string;
    balance?: number;
    points?: number;
    name?: string;
    email?: string;
  };
  hasOverduePayments?: boolean;
  totalOverdueAmount?: number;
  overdueCount?: number;
  overduePaymentsCount?: number;
  overdueReceivablesCount?: number;
  overdueDetails?: RemoteOverdueDetail[] | string;
  overdueDetailsText?: string;
  details?: string;
};

type CampusConfig = {
  campus: string;
  envKey: string;
  requiredForValidation?: boolean;
};

type CampusCheckResult = {
  campus: string;
  ok: boolean;
  statusCode?: number;
  data?: RemoteFinanceData;
  error?: string;
  matchedQueryField?: string;
  matchedQueryPhone?: string;
  returnedPhone?: string;
  returnedWhatsapp?: string;
  matchReason?: "payload" | "whatsapp-query" | "email-query" | "linked-phone-query";
  attempts?: Array<{
    field: string;
    value: string;
    statusCode: number;
    matched: boolean;
    overdue: boolean;
    reason?: string;
  }>;
};

const CAMPUS_CONFIG: CampusConfig[] = [
  { campus: "API PRUEBAS", envKey: "FINANCE_API_KEY_TESTS", requiredForValidation: false },
  { campus: "UDEL Online", envKey: "FINANCE_API_KEY_UDEL_ONLINE" },
  { campus: "UDEL Los Cabos", envKey: "FINANCE_API_KEY_UDEL_LOS_CABOS" },
  { campus: "UDEL Lazaro Cardenas", envKey: "FINANCE_API_KEY_UDEL_LAZARO_CARDENAS" },
  { campus: "UDEL Victoria", envKey: "FINANCE_API_KEY_UDEL_VICTORIA" },
  { campus: "UDEL Culiacan", envKey: "FINANCE_API_KEY_UDEL_CULIACAN" },
  { campus: "UDEL La Paz", envKey: "FINANCE_API_KEY_UDEL_LA_PAZ" },
  { campus: "UDEL Zihuatanejo", envKey: "FINANCE_API_KEY_UDEL_ZIHUATANEJO" },
];

const hasOverdue = (data: RemoteFinanceData) =>
  Boolean(data.hasOverduePayments) ||
  (data.totalOverdueAmount ?? 0) > 0 ||
  (data.overdueCount ?? 0) > 0 ||
  (data.overduePaymentsCount ?? 0) > 0 ||
  (data.overdueReceivablesCount ?? 0) > 0 ||
  toNumber(data.balance) > 0 ||
  toNumber(data.customer?.balance) > 0;

const toNumber = (value: unknown) => {
  const parsed = toNumberish(value);
  return parsed ?? 0;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const toNumberish = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!normalized) return undefined;
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : undefined;
};

const toBooleanish = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "1", "yes", "si", "sí"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
};

const pickString = (
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined => {
  if (!source) return undefined;
  for (const key of keys) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

const pickNumber = (
  source: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined => {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = toNumberish(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const pickBoolean = (
  source: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined => {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = toBooleanish(source[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const extractFinanceData = (
  parsedBody: unknown,
): { success?: boolean; error?: string; data?: RemoteFinanceData } => {
  const response = asRecord(parsedBody);
  if (!response) return {};

  const success = typeof response.success === "boolean" ? response.success : undefined;
  const error = typeof response.error === "string" ? response.error : undefined;

  const responseData = asRecord(response.data);
  const responseCustomer = asRecord(response.customer);
  const data = responseData ?? (responseCustomer ? { customer: responseCustomer } : undefined);
  if (!data) {
    return { success, error };
  }

  const nestedCustomer = asRecord(data.customer) ?? responseCustomer;
  const clabe = asRecord(data.clabe);

  return {
    success,
    error,
    data: {
      ...data,
      phone:
        pickString(data, ["phone", "Phone", "telefono", "tel", "cellphone", "mobile"]) ??
        pickString(nestedCustomer, ["phone", "Phone", "telefono", "tel", "cellphone", "mobile"]),
      whatsapp:
        pickString(data, ["whatsapp", "WhatsApp", "whatsApp", "wa", "whatsappPhone", "whatsappNumber"]) ??
        pickString(nestedCustomer, ["whatsapp", "WhatsApp", "whatsApp", "wa", "whatsappPhone", "whatsappNumber"]),
      name:
        pickString(data, ["name", "Name", "nombre"]) ??
        pickString(nestedCustomer, ["name", "Name", "nombre"]),
      email:
        pickString(data, ["email", "Email", "correo"]) ??
        pickString(nestedCustomer, ["email", "Email", "correo"]),
      hasOverduePayments:
        pickBoolean(data, ["hasOverduePayments", "HasOverduePayments", "overdue", "hasDebt", "adeudo"]) ??
        pickBoolean(nestedCustomer, ["hasOverduePayments", "HasOverduePayments", "overdue", "hasDebt", "adeudo"]),
      totalOverdueAmount:
        pickNumber(data, ["totalOverdueAmount", "TotalOverdueAmount", "totalDebt", "debtAmount"]) ??
        pickNumber(nestedCustomer, ["totalOverdueAmount", "TotalOverdueAmount", "totalDebt", "debtAmount"]),
      overdueCount:
        pickNumber(data, ["overdueCount", "OverdueCount", "debtCount"]) ??
        pickNumber(nestedCustomer, ["overdueCount", "OverdueCount", "debtCount"]),
      overduePaymentsCount:
        pickNumber(data, ["overduePaymentsCount", "OverduePaymentsCount"]) ??
        pickNumber(nestedCustomer, ["overduePaymentsCount", "OverduePaymentsCount"]),
      overdueReceivablesCount:
        pickNumber(data, ["overdueReceivablesCount", "OverdueReceivablesCount"]) ??
        pickNumber(nestedCustomer, ["overdueReceivablesCount", "OverdueReceivablesCount"]),
      balance:
        pickNumber(data, ["balance", "Balance", "debt", "adeudo"]) ??
        pickNumber(nestedCustomer, ["balance", "Balance", "debt", "adeudo"]),
      points:
        pickNumber(data, ["points", "Points"]) ??
        pickNumber(nestedCustomer, ["points", "Points"]),
      clabe:
        clabe
          ? {
              clabe: pickString(clabe, ["clabe", "CLABE"]),
              bank: pickString(clabe, ["bank", "Bank", "banco"]),
            }
          : undefined,
      customer: nestedCustomer
        ? {
            phone: pickString(nestedCustomer, ["phone", "Phone", "telefono", "tel", "cellphone", "mobile"]),
            whatsapp: pickString(nestedCustomer, ["whatsapp", "WhatsApp", "whatsApp", "wa", "whatsappPhone", "whatsappNumber"]),
            name: pickString(nestedCustomer, ["name", "Name", "nombre"]),
            email: pickString(nestedCustomer, ["email", "Email", "correo"]),
            balance:
              pickNumber(nestedCustomer, ["balance", "Balance", "debt", "adeudo"]) ?? undefined,
            points: pickNumber(nestedCustomer, ["points", "Points"]) ?? undefined,
          }
        : undefined,
    } as RemoteFinanceData,
  };
};

const digitsOnly = (value?: string | null): string => (value ?? "").replace(/\D/g, "");
const normalizeEmail = (value?: string | null): string => (value ?? "").trim().toLowerCase();

const toMxLocal10Digits = (value?: string | null): string => {
  const digits = digitsOnly(value);
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const buildPhoneCandidates = (value: string): string[] => {
  const digits = digitsOnly(value);
  const local10 = toMxLocal10Digits(value);
  const candidates = new Set<string>();
  if (digits) candidates.add(digits);
  if (local10) {
    candidates.add(local10);
    candidates.add(`52${local10}`);
    candidates.add(`521${local10}`);
  }
  return Array.from(candidates);
};

const normalizeFinanceData = (data: RemoteFinanceData): RemoteFinanceData => {
  const customer = data.customer;
  return {
    ...data,
    phone: data.phone ?? customer?.phone,
    whatsapp: data.whatsapp ?? customer?.whatsapp,
    name: data.name ?? customer?.name,
    email: data.email ?? customer?.email,
  };
};

const collectReturnedPhones = (data: RemoteFinanceData): string[] => {
  const normalized = normalizeFinanceData(data);
  const values = [
    normalized.phone,
    normalized.whatsapp,
    normalized.customer?.phone,
    normalized.customer?.whatsapp,
  ];
  return Array.from(new Set(values.map((value) => digitsOnly(value)).filter(Boolean)));
};

const matchesRequestedPhoneOrWhatsapp = (
  requestedCandidates: string[],
  data: RemoteFinanceData,
): boolean => {
  const requestedCandidatesSet = new Set(requestedCandidates);
  const returnedPhones = collectReturnedPhones(data);

  // Si la API no devuelve phone/whatsapp, mantenemos compatibilidad (no bloqueamos).
  if (!returnedPhones.length) return true;

  const returnedCandidates = new Set(
    returnedPhones.flatMap((phone) => buildPhoneCandidates(phone)),
  );

  for (const candidate of requestedCandidatesSet) {
    if (returnedCandidates.has(candidate)) return true;
  }

  return false;
};

const buildLookupPhones = (values: Array<string | null | undefined>): string[] => {
  const set = new Set<string>();
  for (const value of values) {
    const local10 = toMxLocal10Digits(value);
    if (local10.length === 10) {
      set.add(local10);
    }
  }
  return Array.from(set);
};

const extractCustomerInfoPhones = (
  parsedBody: unknown,
): { success?: boolean; error?: string; phone?: string; whatsapp?: string } => {
  const response = asRecord(parsedBody);
  if (!response) return {};

  const success = typeof response.success === "boolean" ? response.success : undefined;
  const error = typeof response.error === "string" ? response.error : undefined;

  const responseData = asRecord(response.data);
  const customer =
    asRecord(responseData?.customer) ??
    asRecord(response.customer) ??
    responseData;

  return {
    success,
    error,
    phone: pickString(customer, ["phone", "Phone", "telefono", "tel", "cellphone", "mobile"]),
    whatsapp: pickString(customer, ["whatsapp", "WhatsApp", "whatsApp", "wa", "whatsappPhone", "whatsappNumber"]),
  };
};

const extractApiErrorCode = (parsedBody: unknown): string | undefined => {
  const response = asRecord(parsedBody);
  if (!response) return undefined;
  const errorObj = asRecord(response.error);
  const code = errorObj?.code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
};

export async function GET(request: NextRequest) {
  const configuredFinanceUrl =
    process.env.FINANCE_API_URL ?? "https://us-central1-pos-universal-662da.cloudfunctions.net/customerStatus";
  const financeBaseUrl = configuredFinanceUrl
    .replace(/\/customerStatus\/?$/i, "")
    .replace(/\/customerInfo\/?$/i, "");
  const FINANCE_STATUS_URL = `${financeBaseUrl}/customerStatus`;
  const FINANCE_INFO_URL = `${financeBaseUrl}/customerInfo`;
  const phone = request.nextUrl.searchParams.get("phone")?.trim();
  const whatsapp = request.nextUrl.searchParams.get("whatsapp")?.trim();
  const email = normalizeEmail(request.nextUrl.searchParams.get("email"));
  const debugMode = request.nextUrl.searchParams.get("debug") === "1";

  if (!phone && !whatsapp) {
    return NextResponse.json({ error: "phone o whatsapp es requerido" }, { status: 400 });
  }

  const configuredCampuses = CAMPUS_CONFIG
    .map((campus) => {
      const key = process.env[campus.envKey]?.trim();
      return {
        campus: campus.campus,
        envKey: campus.envKey,
        requiredForValidation: campus.requiredForValidation !== false,
        key,
      };
    })
    .filter(
      (
        campus,
      ): campus is { campus: string; envKey: string; requiredForValidation: boolean; key: string } =>
        Boolean(campus.key),
    );

  // Compatibilidad con configuración anterior de una sola API key.
  if (!configuredCampuses.length && process.env.FINANCE_API_KEY) {
    configuredCampuses.push({
      campus: "Plantel Principal",
      envKey: "FINANCE_API_KEY",
      requiredForValidation: true,
      key: process.env.FINANCE_API_KEY,
    });
  }

  if (!configuredCampuses.length) {
    console.error("No hay API keys de finanzas configuradas");
    return NextResponse.json(
      {
        error:
          "No hay API keys configuradas. Define FINANCE_API_KEY_TESTS y/o FINANCE_API_KEY_UDEL_* en el entorno.",
      },
      { status: 500 },
    );
  }

  try {
    const requestedLookupPhones = buildLookupPhones([phone, whatsapp]);
    if (!requestedLookupPhones.length) {
      return NextResponse.json({ error: "phone o whatsapp invalido" }, { status: 400 });
    }
    const requestedCandidates = Array.from(
      new Set(requestedLookupPhones.flatMap((lookupPhone) => buildPhoneCandidates(lookupPhone))),
    );

    const results: CampusCheckResult[] = await Promise.all(
      configuredCampuses.map(async ({ campus, key }): Promise<CampusCheckResult> => {
        let firstStatusError: string | undefined;
        let firstMatchedResult: CampusCheckResult | undefined;
        const attempts: Array<{
          field: string;
          value: string;
          statusCode: number;
          matched: boolean;
          overdue: boolean;
          reason?: string;
        }> = [];
        const pushAttempt = (attempt: {
          field: string;
          value: string;
          statusCode: number;
          matched: boolean;
          overdue: boolean;
          reason?: string;
        }) => {
          if (!debugMode) return;
          if (attempts.length >= 60) return;
          attempts.push(attempt);
        };

        const lookupPhones = new Set<string>(requestedLookupPhones);
        const infoQueue = [...requestedLookupPhones];
        const infoVisited = new Set<string>();

        while (infoQueue.length) {
          const lookupPhone = infoQueue.shift();
          if (!lookupPhone || infoVisited.has(lookupPhone)) continue;
          infoVisited.add(lookupPhone);
          try {
            const infoResp = await fetch(`${FINANCE_INFO_URL}?phone=${encodeURIComponent(lookupPhone)}`, {
              headers: {
                "X-API-Key": key,
              },
              cache: "no-store",
            });
            const infoRawBody = await infoResp.text();
            let infoParsedBody: unknown = {};
            if (infoRawBody) {
              try {
                infoParsedBody = JSON.parse(infoRawBody);
              } catch {
                infoParsedBody = { rawBody: infoRawBody };
              }
            }

            if (infoResp.status === 404) {
              pushAttempt({
                field: "customerInfo",
                value: lookupPhone,
                statusCode: 404,
                matched: false,
                overdue: false,
                reason: "NOT_FOUND",
              });
              continue;
            }

            if (!infoResp.ok) {
              const apiErrorCode = extractApiErrorCode(infoParsedBody);
              const reason = apiErrorCode ? `HTTP_${infoResp.status}_${apiErrorCode}` : `HTTP_${infoResp.status}`;
              pushAttempt({
                field: "customerInfo",
                value: lookupPhone,
                statusCode: infoResp.status,
                matched: false,
                overdue: false,
                reason,
              });
              continue;
            }

            const infoParsed = extractCustomerInfoPhones(infoParsedBody);
            if (infoParsed.success === false) {
              pushAttempt({
                field: "customerInfo",
                value: lookupPhone,
                statusCode: infoResp.status,
                matched: false,
                overdue: false,
                reason: infoParsed.error || "EMPTY_DATA",
              });
              continue;
            }

            const discoveredLookupPhones = buildLookupPhones([infoParsed.phone, infoParsed.whatsapp]);
            for (const discoveredPhone of discoveredLookupPhones) {
              if (lookupPhones.has(discoveredPhone)) continue;
              lookupPhones.add(discoveredPhone);
              infoQueue.push(discoveredPhone);
            }

            pushAttempt({
              field: "customerInfo",
              value: lookupPhone,
              statusCode: infoResp.status,
              matched: discoveredLookupPhones.length > 0,
              overdue: false,
              reason:
                discoveredLookupPhones.length > 0
                  ? `LINKED_${discoveredLookupPhones.join("_")}`
                  : "NO_LINKED_PHONE",
            });
          } catch {
            pushAttempt({
              field: "customerInfo",
              value: lookupPhone,
              statusCode: 0,
              matched: false,
              overdue: false,
              reason: "NETWORK_ERROR",
            });
          }
        }

        const statusLookupPhones = Array.from(lookupPhones);
        for (const lookupPhone of statusLookupPhones) {
          try {
            const statusResp = await fetch(`${FINANCE_STATUS_URL}?phone=${encodeURIComponent(lookupPhone)}`, {
              headers: {
                "X-API-Key": key,
              },
              cache: "no-store",
            });

            const statusRawBody = await statusResp.text();
            let statusParsedBody: unknown = {};
            if (statusRawBody) {
              try {
                statusParsedBody = JSON.parse(statusRawBody);
              } catch {
                statusParsedBody = { rawBody: statusRawBody };
              }
            }

            if (statusResp.status === 404) {
              pushAttempt({
                field: "phone",
                value: lookupPhone,
                statusCode: 404,
                matched: false,
                overdue: false,
                reason: "NOT_FOUND",
              });
              continue;
            }

            if (!statusResp.ok) {
              const apiErrorCode = extractApiErrorCode(statusParsedBody);
              const reason = apiErrorCode ? `HTTP_${statusResp.status}_${apiErrorCode}` : `HTTP_${statusResp.status}`;
              pushAttempt({
                field: "phone",
                value: lookupPhone,
                statusCode: statusResp.status,
                matched: false,
                overdue: false,
                reason,
              });
              firstStatusError =
                firstStatusError ??
                (apiErrorCode ? `HTTP ${statusResp.status} (${apiErrorCode})` : `HTTP ${statusResp.status}`);
              continue;
            }

            const statusParsed = extractFinanceData(statusParsedBody);
            if (statusParsed.success === false || !statusParsed.data) {
              pushAttempt({
                field: "phone",
                value: lookupPhone,
                statusCode: statusResp.status,
                matched: false,
                overdue: false,
                reason: statusParsed.error || "EMPTY_DATA",
              });
              firstStatusError = firstStatusError ?? (statusParsed.error || "Respuesta sin data");
              continue;
            }

            const normalizedData = normalizeFinanceData(statusParsed.data);
            const hasDebt = hasOverdue(normalizedData);
            const matchedByPayload = matchesRequestedPhoneOrWhatsapp(requestedCandidates, normalizedData);
            const isLinkedLookupPhone = !requestedLookupPhones.includes(lookupPhone);
            if (!matchedByPayload && !isLinkedLookupPhone) {
              pushAttempt({
                field: "phone",
                value: lookupPhone,
                statusCode: statusResp.status,
                matched: false,
                overdue: hasDebt,
                reason: "NO_MATCH",
              });
              continue;
            }

            const matchReason: CampusCheckResult["matchReason"] = isLinkedLookupPhone
              ? "linked-phone-query"
              : "payload";
            pushAttempt({
              field: "phone",
              value: lookupPhone,
              statusCode: statusResp.status,
              matched: true,
              overdue: hasDebt,
              reason: matchReason,
            });

            const matchedResult: CampusCheckResult = {
              campus,
              ok: true,
              statusCode: statusResp.status,
              data: normalizedData,
              matchedQueryField: "phone",
              matchedQueryPhone: lookupPhone,
              returnedPhone: normalizedData.phone,
              returnedWhatsapp: normalizedData.whatsapp,
              matchReason,
              attempts: debugMode ? [...attempts] : undefined,
            };

            if (hasDebt) {
              return matchedResult;
            }

            if (!firstMatchedResult) {
              firstMatchedResult = matchedResult;
            }
          } catch (err: unknown) {
            pushAttempt({
              field: "phone",
              value: lookupPhone,
              statusCode: 0,
              matched: false,
              overdue: false,
              reason: "NETWORK_ERROR",
            });
            firstStatusError =
              firstStatusError ??
              ((err as { message?: string })?.message || "Error de red al consultar plantel");
          }
        }

        if (firstMatchedResult) {
          return firstMatchedResult;
        }

        // Si ningun intento coincidió pero hubo error HTTP/red, reportarlo como fallo del plantel.
        if (firstStatusError) {
          return {
            campus,
            ok: false,
            error: firstStatusError,
            attempts: debugMode ? attempts : undefined,
          };
        }

        // Si no hubo errores y solo hubo "no encontrado / sin coincidencia", no bloqueamos.
        return {
          campus,
          ok: true,
          statusCode: 404,
          data: {
            phone: phone ?? whatsapp ?? "",
            hasOverduePayments: false,
            totalOverdueAmount: 0,
            overdueCount: 0,
            overduePaymentsCount: 0,
            overdueReceivablesCount: 0,
            overdueDetails: [],
          },
          error: "NOT_FOUND",
          matchedQueryPhone: undefined,
          returnedPhone: undefined,
          returnedWhatsapp: undefined,
          attempts: debugMode ? attempts : undefined,
        };
      }),
    );

    const successful = results.filter((item) => item.ok && item.data) as Array<
      CampusCheckResult & { data: RemoteFinanceData }
    >;
    const requiredCampuses = new Set(
      configuredCampuses
        .filter((campus) => campus.requiredForValidation)
        .map((campus) => campus.campus),
    );
    const failedCampuses = results
      .filter((item) => !item.ok)
      .map((item) => ({ campus: item.campus, error: item.error || "Error desconocido" }));
    const blockingFailedCampuses = failedCampuses.filter((item) => requiredCampuses.has(item.campus));
    const nonBlockingFailedCampuses = failedCampuses.filter((item) => !requiredCampuses.has(item.campus));

    if (!successful.length) {
      return NextResponse.json(
        {
          success: false,
          error: "No se pudo consultar ningun plantel",
          campusesChecked: results.length,
          failedCampuses,
        },
        { status: 502 },
      );
    }

    // Fail closed solo en planteles requeridos: planteles de prueba no deben bloquear el acceso.
    if (blockingFailedCampuses.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: "No se pudo validar adeudos en todos los planteles",
          campusesChecked: successful.map((item) => item.campus),
          failedCampuses: blockingFailedCampuses,
          ignoredFailedCampuses: nonBlockingFailedCampuses,
          ...(debugMode
            ? {
                debug: {
                  requestedPhone: phone,
                  requestedWhatsapp: whatsapp,
                  requestedEmail: email || undefined,
                  requestedLookupPhones,
                  requestedCandidates,
                  campusResults: results.map((item) => ({
                    campus: item.campus,
                    ok: item.ok,
                    statusCode: item.statusCode,
                    error: item.error,
                    matchedQueryField: item.matchedQueryField,
                    matchedQueryPhone: item.matchedQueryPhone,
                    returnedPhone: item.returnedPhone,
                    returnedWhatsapp: item.returnedWhatsapp,
                    matchReason: item.matchReason,
                    attempts: item.attempts,
                  })),
                },
              }
            : undefined),
        },
        { status: 502 },
      );
    }

    const overdueCampuses = successful.filter((item) => hasOverdue(item.data));
    const firstData = overdueCampuses[0]?.data ?? successful[0].data;

    const aggregatedDetails = overdueCampuses.flatMap((item) => {
      const source = item.data.overdueDetails;
      if (Array.isArray(source)) {
        return source.map((detail) => ({
          ...detail,
          campus: item.campus,
        }));
      }
      if (typeof source === "string" && source.trim()) {
        return [
          {
            type: "text",
            concept: source.trim(),
            campus: item.campus,
          },
        ];
      }
      return [];
    });

    const totalOverdueAmount = overdueCampuses.reduce((acc, item) => acc + toNumber(item.data.totalOverdueAmount), 0);
    const overdueCount = overdueCampuses.reduce((acc, item) => acc + toNumber(item.data.overdueCount), 0);
    const overduePaymentsCount = overdueCampuses.reduce(
      (acc, item) => acc + toNumber(item.data.overduePaymentsCount),
      0,
    );
    const overdueReceivablesCount = overdueCampuses.reduce(
      (acc, item) => acc + toNumber(item.data.overdueReceivablesCount),
      0,
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          phone: firstData.phone ?? phone ?? whatsapp ?? "",
          whatsapp: firstData.whatsapp,
          name: firstData.name,
          email: firstData.email,
          clabe: firstData.clabe,
          hasOverduePayments: overdueCampuses.length > 0,
          totalOverdueAmount,
          overdueCount,
          overduePaymentsCount,
          overdueReceivablesCount,
          overdueDetails: aggregatedDetails,
          campusesChecked: successful.map((item) => item.campus),
          notFoundCampuses: successful
            .filter((item) => item.error === "NOT_FOUND")
            .map((item) => item.campus),
          failedCampuses: blockingFailedCampuses,
          ignoredFailedCampuses: nonBlockingFailedCampuses,
          overdueCampuses: overdueCampuses.map((item) => item.campus),
        },
        ...(debugMode
          ? {
              debug: {
                requestedPhone: phone,
                requestedWhatsapp: whatsapp,
                requestedEmail: email || undefined,
                requestedLookupPhones,
                requestedCandidates,
                campusResults: results.map((item) => ({
                  campus: item.campus,
                  ok: item.ok,
                  statusCode: item.statusCode,
                  error: item.error,
                  matchedQueryField: item.matchedQueryField,
                  matchedQueryPhone: item.matchedQueryPhone,
                  returnedPhone: item.returnedPhone,
                  returnedWhatsapp: item.returnedWhatsapp,
                  matchReason: item.matchReason,
                  attempts: item.attempts,
                })),
              },
            }
          : undefined),
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("Error consultando finanzas por plantel:", err);
    return NextResponse.json({ error: "Error consultando finanzas" }, { status: 500 });
  }
}
