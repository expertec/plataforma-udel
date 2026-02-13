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
  name?: string;
  email?: string;
  clabe?: {
    clabe?: string;
    bank?: string;
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

type RemoteFinanceResponse = {
  success?: boolean;
  data?: RemoteFinanceData;
  error?: string;
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
  (data.overdueReceivablesCount ?? 0) > 0;

const toNumber = (value: unknown) => {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export async function GET(request: NextRequest) {
  const FINANCE_API_URL =
    process.env.FINANCE_API_URL ?? "https://us-central1-pos-universal-662da.cloudfunctions.net/customerStatus";
  const phone = request.nextUrl.searchParams.get("phone")?.trim();

  if (!phone) {
    return NextResponse.json({ error: "phone es requerido" }, { status: 400 });
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
    const results: CampusCheckResult[] = await Promise.all(
      configuredCampuses.map(async ({ campus, key }): Promise<CampusCheckResult> => {
        try {
          const url = `${FINANCE_API_URL}?phone=${encodeURIComponent(phone)}`;

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

          if (!resp.ok) {
            return {
              campus,
              ok: false,
              statusCode: resp.status,
              error: `HTTP ${resp.status}`,
            };
          }

          const parsed = parsedBody as RemoteFinanceResponse;
          if (!parsed?.success || !parsed?.data) {
            return {
              campus,
              ok: false,
              statusCode: resp.status,
              error: parsed?.error || "Respuesta sin data",
            };
          }

          return {
            campus,
            ok: true,
            statusCode: resp.status,
            data: parsed.data,
          };
        } catch (err: unknown) {
          return {
            campus,
            ok: false,
            error: (err as { message?: string })?.message || "Error de red al consultar plantel",
          };
        }
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
          phone: firstData.phone ?? phone,
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
          failedCampuses: results
            .filter((item) => !item.ok)
            .map((item) => ({ campus: item.campus, error: item.error || "Error desconocido" })),
          overdueCampuses: overdueCampuses.map((item) => item.campus),
        },
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    console.error("Error consultando finanzas por plantel:", err);
    return NextResponse.json({ error: "Error consultando finanzas" }, { status: 500 });
  }
}
