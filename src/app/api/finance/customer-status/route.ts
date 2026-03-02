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
  { campus: "API PRUEBAS", envKey: "FINANCE_API_KEY_TESTS" },
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

const hasCandidateMatch = (source: string[], targetSet: Set<string>): boolean =>
  source.some((candidate) => targetSet.has(candidate));

export async function GET(request: NextRequest) {
  const FINANCE_API_URL =
    process.env.FINANCE_API_URL ?? "https://us-central1-pos-universal-662da.cloudfunctions.net/customerStatus";
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
        key,
      };
    })
    .filter((campus): campus is { campus: string; envKey: string; key: string } => Boolean(campus.key));

  // Compatibilidad con configuración anterior de una sola API key.
  if (!configuredCampuses.length && process.env.FINANCE_API_KEY) {
    configuredCampuses.push({
      campus: "Plantel Principal",
      envKey: "FINANCE_API_KEY",
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
    const requestedCandidates = Array.from(
      new Set([...(phone ? buildPhoneCandidates(phone) : []), ...(whatsapp ? buildPhoneCandidates(whatsapp) : [])]),
    );
    const requestedEmailCandidates = Array.from(new Set([email].filter(Boolean)));
    if (!requestedCandidates.length) {
      return NextResponse.json({ error: "phone o whatsapp invalido" }, { status: 400 });
    }
    const requestedCandidateSet = new Set(requestedCandidates);

    const queryStrategies: Array<{ field: string; param: string }> = [
      { field: "phone", param: "phone" },
      { field: "whatsapp", param: "whatsapp" },
      { field: "wa", param: "wa" },
      { field: "whatsappPhone", param: "whatsappPhone" },
      { field: "whatsappNumber", param: "whatsappNumber" },
      { field: "mobile", param: "mobile" },
      { field: "cellphone", param: "cellphone" },
      { field: "telefono", param: "telefono" },
      { field: "tel", param: "tel" },
      { field: "celular", param: "celular" },
      { field: "email", param: "email" },
      { field: "mail", param: "mail" },
      { field: "correo", param: "correo" },
    ];

    const results: CampusCheckResult[] = await Promise.all(
      configuredCampuses.map(async ({ campus, key }): Promise<CampusCheckResult> => {
        let firstError: string | undefined;
        let firstMatchedResult: CampusCheckResult | undefined;
        const attempts: Array<{
          field: string;
          value: string;
          statusCode: number;
          matched: boolean;
          overdue: boolean;
          reason?: string;
        }> = [];

        for (const strategy of queryStrategies) {
          const isEmailStrategy =
            strategy.field === "email" || strategy.field === "mail" || strategy.field === "correo";
          const queryValues = isEmailStrategy ? requestedEmailCandidates : requestedCandidates;
          for (const queryPhone of queryValues) {
            try {
              const url = `${FINANCE_API_URL}?${strategy.param}=${encodeURIComponent(queryPhone)}`;

              const resp = await fetch(url, {
                headers: {
                  "X-API-Key": key,
                },
                cache: "no-store",
              });

              const rawBody = await resp.text();
              let parsedBody: unknown = {};
              if (rawBody) {
                try {
                  parsedBody = JSON.parse(rawBody);
                } catch {
                  parsedBody = { rawBody };
                }
              }

              // En algunos planteles la API responde 404 cuando no existe.
              if (resp.status === 404) {
                attempts.push({
                  field: strategy.field,
                  value: queryPhone,
                  statusCode: 404,
                  matched: false,
                  overdue: false,
                  reason: "NOT_FOUND",
                });
                continue;
              }

              if (!resp.ok) {
                // Algunas APIs no soportan query por whatsapp y devuelven 400.
                if (strategy.field !== "phone" && resp.status === 400) {
                  attempts.push({
                    field: strategy.field,
                    value: queryPhone,
                    statusCode: 400,
                    matched: false,
                    overdue: false,
                    reason: "UNSUPPORTED_PARAM",
                  });
                  continue;
                }
                attempts.push({
                  field: strategy.field,
                  value: queryPhone,
                  statusCode: resp.status,
                  matched: false,
                  overdue: false,
                  reason: `HTTP_${resp.status}`,
                });
                firstError = firstError ?? `HTTP ${resp.status}`;
                continue;
              }

              const parsed = extractFinanceData(parsedBody);
              if (parsed.success === false || !parsed.data) {
                attempts.push({
                  field: strategy.field,
                  value: queryPhone,
                  statusCode: resp.status,
                  matched: false,
                  overdue: false,
                  reason: parsed.error || "EMPTY_DATA",
                });
                firstError = firstError ?? (parsed.error || "Respuesta sin data");
                continue;
              }

              const normalizedData = normalizeFinanceData(parsed.data);
              const hasDebt = hasOverdue(normalizedData);
              const returnedEmail = normalizeEmail(normalizedData.email);
              const queryEmail = normalizeEmail(queryPhone);

              const matchedByPayload = matchesRequestedPhoneOrWhatsapp(requestedCandidates, normalizedData);
              // Si la búsqueda fue por whatsapp, aceptamos el resultado aunque la API no regrese
              // explícitamente el campo whatsapp en el payload.
              const matchedByWhatsappQuery = !isEmailStrategy && strategy.field !== "phone";
              const matchedByEmailQuery =
                isEmailStrategy && queryEmail.length > 0 && (!returnedEmail || returnedEmail === queryEmail);
              if (!matchedByPayload && !matchedByWhatsappQuery && !matchedByEmailQuery) {
                attempts.push({
                  field: strategy.field,
                  value: queryPhone,
                  statusCode: resp.status,
                  matched: false,
                  overdue: hasDebt,
                  reason: "NO_MATCH",
                });
                continue;
              }

              const matchedResult: CampusCheckResult = {
                campus,
                ok: true,
                statusCode: resp.status,
                data: normalizedData,
                matchedQueryField: strategy.field,
                matchedQueryPhone: queryPhone,
                returnedPhone: normalizedData.phone,
                returnedWhatsapp: normalizedData.whatsapp,
                matchReason: matchedByPayload
                  ? "payload"
                  : matchedByEmailQuery
                    ? "email-query"
                    : "whatsapp-query",
                attempts: debugMode ? [...attempts] : undefined,
              };
              if (debugMode) {
                matchedResult.attempts = [
                  ...(matchedResult.attempts ?? []),
                  {
                    field: strategy.field,
                    value: queryPhone,
                    statusCode: resp.status,
                    matched: true,
                    overdue: hasDebt,
                    reason: matchedResult.matchReason,
                  },
                ];
              }

              const returnedPhoneDigits = digitsOnly(normalizedData.phone ?? normalizedData.customer?.phone);
              const returnedPhoneCandidates = returnedPhoneDigits
                ? buildPhoneCandidates(returnedPhoneDigits)
                : [];
              const returnedWhatsappDigits = digitsOnly(normalizedData.whatsapp ?? normalizedData.customer?.whatsapp);
              const returnedWhatsappCandidates = returnedWhatsappDigits
                ? buildPhoneCandidates(returnedWhatsappDigits)
                : [];
              const matchedByReturnedWhatsapp = hasCandidateMatch(
                returnedWhatsappCandidates,
                requestedCandidateSet,
              );
              const requestedAlreadyContainsReturnedPhone = hasCandidateMatch(
                returnedPhoneCandidates,
                requestedCandidateSet,
              );

              // Caso clave: si el número del alumno coincide con whatsapp en finanzas,
              // también validamos adeudo del phone enlazado de ese registro.
              const shouldCheckLinkedPhoneDebt =
                !hasDebt &&
                returnedPhoneCandidates.length > 0 &&
                !requestedAlreadyContainsReturnedPhone &&
                (matchedByReturnedWhatsapp || matchedByWhatsappQuery);

              if (shouldCheckLinkedPhoneDebt) {
                for (const linkedPhone of returnedPhoneCandidates) {
                  try {
                    const linkedResp = await fetch(
                      `${FINANCE_API_URL}?phone=${encodeURIComponent(linkedPhone)}`,
                      {
                        headers: {
                          "X-API-Key": key,
                        },
                        cache: "no-store",
                      },
                    );

                    const linkedRawBody = await linkedResp.text();
                    let linkedParsedBody: unknown = {};
                    if (linkedRawBody) {
                      try {
                        linkedParsedBody = JSON.parse(linkedRawBody);
                      } catch {
                        linkedParsedBody = { rawBody: linkedRawBody };
                      }
                    }

                    const linkedParsed = extractFinanceData(linkedParsedBody);
                    const linkedData = linkedParsed.data ? normalizeFinanceData(linkedParsed.data) : undefined;
                    const linkedHasDebt = linkedData ? hasOverdue(linkedData) : false;
                    const linkedMatched = linkedData
                      ? matchesRequestedPhoneOrWhatsapp(returnedPhoneCandidates, linkedData)
                      : false;

                    if (debugMode) {
                      matchedResult.attempts = [
                        ...(matchedResult.attempts ?? []),
                        {
                          field: "linked-phone",
                          value: linkedPhone,
                          statusCode: linkedResp.status,
                          matched: linkedMatched,
                          overdue: linkedHasDebt,
                          reason: linkedResp.ok
                            ? linkedMatched
                              ? linkedHasDebt
                                ? "LINKED_OVERDUE"
                                : "LINKED_NO_DEBT"
                              : "LINKED_NO_MATCH"
                            : `HTTP_${linkedResp.status}`,
                        },
                      ];
                    }

                    if (!linkedResp.ok || !linkedData || !linkedMatched || !linkedHasDebt) {
                      continue;
                    }

                    return {
                      ...matchedResult,
                      statusCode: linkedResp.status,
                      data: linkedData,
                      matchedQueryField: "phone",
                      matchedQueryPhone: linkedPhone,
                      returnedPhone: linkedData.phone,
                      returnedWhatsapp: linkedData.whatsapp,
                      matchReason: "linked-phone-query",
                    };
                  } catch {
                    if (debugMode) {
                      matchedResult.attempts = [
                        ...(matchedResult.attempts ?? []),
                        {
                          field: "linked-phone",
                          value: linkedPhone,
                          statusCode: 0,
                          matched: false,
                          overdue: false,
                          reason: "NETWORK_ERROR",
                        },
                      ];
                    }
                  }
                }
              }

              // Si encontramos adeudo en cualquier match del plantel, priorizamos ese resultado.
              if (hasDebt) {
                return matchedResult;
              }

              // Guardar el primer match sin adeudo por si no aparece ninguno con adeudo.
              if (!firstMatchedResult) {
                firstMatchedResult = matchedResult;
              }
            } catch (err: unknown) {
              firstError =
                firstError ??
                ((err as { message?: string })?.message || "Error de red al consultar plantel");
            }
          }
        }

        if (firstMatchedResult) {
          return firstMatchedResult;
        }

        // Si ningun intento coincidió pero hubo error HTTP/red, reportarlo como fallo del plantel.
        if (firstError) {
          return {
            campus,
            ok: false,
            error: firstError,
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

    if (!successful.length) {
      return NextResponse.json(
        {
          success: false,
          error: "No se pudo consultar ningun plantel",
          campusesChecked: results.length,
          failedCampuses: results.map((item) => ({
            campus: item.campus,
            error: item.error || "Error desconocido",
          })),
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
          failedCampuses: results
            .filter((item) => !item.ok)
            .map((item) => ({ campus: item.campus, error: item.error || "Error desconocido" })),
          overdueCampuses: overdueCampuses.map((item) => item.campus),
        },
        ...(debugMode
          ? {
              debug: {
                requestedPhone: phone,
                requestedWhatsapp: whatsapp,
                requestedEmail: email || undefined,
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
          : {}),
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("Error consultando finanzas por plantel:", err);
    return NextResponse.json({ error: "Error consultando finanzas" }, { status: 500 });
  }
}
