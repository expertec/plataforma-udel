import { normalizePlantelName, type Plantel } from "@/lib/firebase/planteles-service";

export type SuggestedPlantelByPhone = {
  plantelId: string;
  plantelName: string;
  lada: string;
};

type LadaKeywordRule = {
  ladas: string[];
  keywords: string[];
};

const TWO_DIGIT_LADAS = new Set(["33", "55", "56", "81"]);

const LADA_KEYWORD_RULES: LadaKeywordRule[] = [
  { ladas: ["33"], keywords: ["guadalajara", "zapopan", "tonala", "tonala", "tlaquepaque"] },
  { ladas: ["55", "56"], keywords: ["cdmx", "ciudad de mexico", "iztapalapa", "coyoacan", "naucalpan", "ecatepec", "tlalnepantla", "nezahualcoyotl", "cuautitlan"] },
  { ladas: ["81"], keywords: ["monterrey", "guadalupe", "apodaca", "san nicolas", "san pedro", "escobedo", "santa catarina", "garcia", "juarez"] },
  { ladas: ["222"], keywords: ["puebla"] },
  { ladas: ["229"], keywords: ["veracruz"] },
  { ladas: ["228"], keywords: ["xalapa"] },
  { ladas: ["311"], keywords: ["tepic"] },
  { ladas: ["312"], keywords: ["colima"] },
  { ladas: ["442"], keywords: ["queretaro"] },
  { ladas: ["443"], keywords: ["morelia"] },
  { ladas: ["444"], keywords: ["san luis potosi", "slp"] },
  { ladas: ["449"], keywords: ["aguascalientes"] },
  { ladas: ["477"], keywords: ["leon"] },
  { ladas: ["492"], keywords: ["zacatecas"] },
  { ladas: ["612"], keywords: ["la paz"] },
  { ladas: ["624"], keywords: ["los cabos", "cabo san lucas", "san jose del cabo"] },
  { ladas: ["614"], keywords: ["chihuahua"] },
  { ladas: ["644"], keywords: ["obregon", "ciudad obregon"] },
  { ladas: ["646"], keywords: ["ensenada"] },
  { ladas: ["662"], keywords: ["hermosillo"] },
  { ladas: ["664"], keywords: ["tijuana"] },
  { ladas: ["667"], keywords: ["culiacan"] },
  { ladas: ["668"], keywords: ["los mochis", "ahome"] },
  { ladas: ["669"], keywords: ["mazatlan"] },
  { ladas: ["686"], keywords: ["mexicali"] },
  { ladas: ["722"], keywords: ["toluca"] },
  { ladas: ["744"], keywords: ["acapulco"] },
  { ladas: ["753"], keywords: ["lazaro cardenas"] },
  { ladas: ["755"], keywords: ["zihuatanejo", "ixtapa"] },
  { ladas: ["833"], keywords: ["tampico"] },
  { ladas: ["834"], keywords: ["victoria", "ciudad victoria"] },
  { ladas: ["844"], keywords: ["saltillo"] },
  { ladas: ["871"], keywords: ["torreon"] },
  { ladas: ["899"], keywords: ["reynosa"] },
  { ladas: ["951"], keywords: ["oaxaca"] },
  { ladas: ["961"], keywords: ["tuxtla"] },
  { ladas: ["962"], keywords: ["tapachula"] },
  { ladas: ["981"], keywords: ["campeche"] },
  { ladas: ["983"], keywords: ["chetumal"] },
  { ladas: ["984"], keywords: ["playa del carmen"] },
  { ladas: ["998"], keywords: ["cancun"] },
  { ladas: ["999"], keywords: ["merida"] },
];

function normalizePhoneToLocal10(value?: string | null): string {
  let digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "";

  // Soporta variantes comunes de números MX: 52, 521 y 0052 al inicio.
  digits = digits.replace(/^00+/, "");
  if (digits.startsWith("521") && digits.length >= 13) {
    digits = digits.slice(3);
  } else if (digits.startsWith("52") && digits.length >= 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith("1") && digits.length === 11) {
    digits = digits.slice(1);
  }

  // Si todavía sobran dígitos, priorizamos los primeros 10 para no romper casos con extensión al final.
  if (digits.length > 10) {
    digits = digits.slice(0, 10);
  }

  return digits;
}

function extractLada(value?: string | null): string | null {
  const localPhone = normalizePhoneToLocal10(value);
  if (localPhone.length !== 10) return null;

  const twoDigitLada = localPhone.slice(0, 2);
  if (TWO_DIGIT_LADAS.has(twoDigitLada)) {
    return twoDigitLada;
  }

  return localPhone.slice(0, 3);
}

export function suggestPlantelByPhone(
  planteles: Plantel[],
  phone?: string | null,
): SuggestedPlantelByPhone | null {
  const lada = extractLada(phone);
  if (!lada) return null;

  const rule = LADA_KEYWORD_RULES.find((candidate) => candidate.ladas.includes(lada));
  if (!rule) return null;

  const matches = planteles.filter((plantel) => {
    const normalizedName = normalizePlantelName(plantel.name);
    return rule.keywords.some((keyword) => normalizedName.includes(normalizePlantelName(keyword)));
  });

  if (matches.length !== 1) return null;

  return {
    plantelId: matches[0].id,
    plantelName: matches[0].name,
    lada,
  };
}
