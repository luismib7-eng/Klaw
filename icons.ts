/**
 * Biblioteca base de íconos de trazo (caja de 160 × 160) compartida por el backend y,
 * en una siguiente iteración, por la vista previa local del frontend.
 * Solo comandos absolutos en mayúscula (M L H V C Q Z): requisito de transformPath().
 */
export type IconId = "idea" | "proceso" | "resultado" | "dinero" | "tiempo" | "equipo" | "objetivo" | "cartel";

export interface IconPath {
  d: string;
  fill?: string;
}

export const ICON_SIZE = 160;

const YELLOW = "#F7DB7A";
const GREEN = "#9FD3B4";
const GOLD = "#E9D3A6";

export const ICONS: Record<IconId, IconPath[]> = {
  idea: [
    { d: "M56 102 C28 76 32 22 80 18 C128 22 132 76 104 102 L102 124 L58 124 Z", fill: YELLOW },
    { d: "M68 102 L74 74 L80 88 L86 74 L92 102" },
    { d: "M62 136 H98" },
    { d: "M66 148 H94" },
  ],
  proceso: [
    { d: "M28 24 H132 Q144 24 144 36 V128 Q144 140 132 140 H28 Q16 140 16 128 V36 Q16 24 28 24 Z" },
    { d: "M30 56 L38 64 L52 48" },
    { d: "M62 58 H130" },
    { d: "M30 90 L38 98 L52 82" },
    { d: "M62 92 H120" },
    { d: "M30 122 L38 130 L52 114" },
    { d: "M62 124 H126" },
  ],
  resultado: [
    { d: "M20 20 V140 H150" },
    { d: "M34 140 V112 H52 V140", fill: GREEN },
    { d: "M64 140 V92 H82 V140", fill: GREEN },
    { d: "M94 140 V68 H112 V140", fill: GREEN },
    { d: "M28 104 L62 78 L90 88 L140 32" },
    { d: "M124 34 L141 31 L138 48" },
  ],
  dinero: [
    { d: "M14 44 H146 V120 H14 Z" },
    { d: "M58 82 C58 70 68 60 80 60 C92 60 102 70 102 82 C102 94 92 104 80 104 C68 104 58 94 58 82 Z", fill: GOLD },
    { d: "M88 72 C84 66 72 67 72 74 C72 82 88 80 88 89 C88 97 75 98 71 92" },
    { d: "M80 62 V102" },
    { d: "M26 56 H40" },
    { d: "M120 108 H134" },
  ],
  tiempo: [
    { d: "M20 80 C20 47 47 20 80 20 C113 20 140 47 140 80 C140 113 113 140 80 140 C47 140 20 113 20 80 Z" },
    { d: "M80 28 V36" },
    { d: "M132 80 H124" },
    { d: "M80 132 V124" },
    { d: "M28 80 H36" },
    { d: "M80 80 V46" },
    { d: "M80 80 L106 94" },
  ],
  equipo: [
    { d: "M40 50 C40 40 48 32 58 32 C68 32 76 40 76 50 C76 60 68 68 58 68 C48 68 40 60 40 50 Z" },
    { d: "M24 132 C24 100 38 84 58 84 C78 84 92 100 92 132" },
    { d: "M92 58 C92 49 99 42 108 42 C117 42 124 49 124 58 C124 67 117 74 108 74 C99 74 92 67 92 58 Z" },
    { d: "M100 132 C102 106 110 92 124 92 C138 92 146 106 146 132" },
  ],
  objetivo: [
    { d: "M20 80 C20 47 47 20 80 20 C113 20 140 47 140 80 C140 113 113 140 80 140 C47 140 20 113 20 80 Z" },
    { d: "M42 80 C42 59 59 42 80 42 C101 42 118 59 118 80 C118 101 101 118 80 118 C59 118 42 101 42 80 Z" },
    { d: "M64 80 C64 71 71 64 80 64 C89 64 96 71 96 80 C96 89 89 96 80 96 C71 96 64 89 64 80 Z", fill: GOLD },
    { d: "M80 80 L146 14" },
    { d: "M128 14 H146 V32" },
  ],
  // Marco provisional para beats de texto hasta que el motor dibuje tipografía.
  cartel: [
    { d: "M22 40 H138 Q150 40 150 52 V108 Q150 120 138 120 H22 Q10 120 10 108 V52 Q10 40 22 40 Z" },
    { d: "M32 70 H128" },
    { d: "M32 92 H104" },
  ],
};

/** Palabras (español e inglés, ya normalizadas) que activan cada ícono. */
export const ICON_KEYWORDS: Record<Exclude<IconId, "cartel">, string[]> = {
  idea: ["idea", "ideas", "concepto", "innovacion", "creatividad", "propuesta", "bulb", "lightbulb", "innovation", "insight"],
  proceso: ["proceso", "procesos", "pasos", "plan", "metodo", "sistema", "estrategia", "flujo", "lista", "process", "steps", "checklist", "workflow", "strategy"],
  resultado: ["resultado", "resultados", "crecimiento", "crecer", "ventas", "venta", "mejora", "impacto", "datos", "medible", "grafica", "growth", "results", "chart", "sales", "data"],
  dinero: ["dinero", "ingresos", "ganancias", "costo", "costos", "precio", "ahorro", "ahorra", "inversion", "pago", "money", "revenue", "cost", "price", "payment", "cash"],
  tiempo: ["tiempo", "rapido", "minutos", "horas", "dia", "dias", "velocidad", "agil", "reloj", "time", "clock", "fast", "speed", "hours"],
  equipo: ["equipo", "personas", "clientes", "cliente", "usuarios", "usuario", "gente", "colaboradores", "team", "people", "customers", "users", "person"],
  objetivo: ["objetivo", "objetivos", "meta", "metas", "enfoque", "exito", "logro", "diana", "goal", "target", "success", "focus"],
};

/** Escala y desplaza un path compuesto solo por comandos absolutos M, L, H, V, C, S, Q, T y Z. */
export function transformPath(d: string, scale: number, dx: number, dy: number): string {
  if (/[a-z]/.test(d)) throw new Error(`transformPath solo admite comandos absolutos: ${d}`);
  const tokens = d.match(/[MLHVCSQTZ]|-?\d*\.?\d+/g) ?? [];
  const out: string[] = [];
  let cmd = "";
  let index = 0;
  for (const tk of tokens) {
    if (/^[MLHVCSQTZ]$/.test(tk)) {
      cmd = tk;
      index = 0;
      out.push(tk);
      continue;
    }
    const n = parseFloat(tk) * scale;
    const v = cmd === "H" ? n + dx : cmd === "V" ? n + dy : n + (index % 2 === 0 ? dx : dy);
    index++;
    out.push(String(Math.round(v * 100) / 100));
  }
  return out.join(" ");
}
