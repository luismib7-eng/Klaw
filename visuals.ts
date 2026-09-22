/**
 * Paso C (nivel MVP): convierte los beats del storyboard en trazos dibujables.
 *
 *  icon          → biblioteca de íconos de trazo por palabra clave
 *  illustration  → misma biblioteca (la generación con Recraft y la caché semántica son Fase 3)
 *  text          → ícono si la palabra coincide; si no, marco provisional "cartel"
 *  chart         → gráfica construida por código a partir de los datos (nunca con IA de imagen)
 *  arrow         → flecha entre las posiciones de fromBeat y toBeat
 */
import { getLength } from "@remotion/paths";
import type { Storyboard } from "../../pipeline/storyboard.js";
import { ICON_KEYWORDS, ICON_SIZE, ICONS, transformPath, type IconId } from "../../pipeline/icons.js";
import { normalizeToken, type DrawablePath } from "../../pipeline/sync.js";

export const VIEWBOX = { w: 960, h: 540 } as const;

type Scene = Storyboard["scenes"][number];
type Beat = Scene["beats"][number];
type Slot = Beat["slot"];

const SLOT_CENTERS: Record<Slot, { x: number; y: number }> = {
  left: { x: 180, y: 280 },
  center: { x: 480, y: 280 },
  right: { x: 780, y: 280 },
  top: { x: 480, y: 150 },
  bottom: { x: 480, y: 410 },
  full: { x: 480, y: 280 },
};
const FALLBACK_ORDER: Slot[] = ["left", "center", "right", "top", "bottom"];

const LOOKUP = new Map<string, IconId>();
for (const [icon, words] of Object.entries(ICON_KEYWORDS) as [IconId, string[]][]) {
  for (const w of words) LOOKUP.set(normalizeToken(w), icon);
}

const path = (d: string, fill?: string): DrawablePath => ({ d, length: getLength(d), fill });

function iconFor(text: string, fallback: IconId): IconId {
  for (const token of text.split(/\s+/)) {
    const hit = LOOKUP.get(normalizeToken(token));
    if (hit) return hit;
  }
  return fallback;
}

function drawIcon(icon: IconId, center: { x: number; y: number }, scale: number): DrawablePath[] {
  const half = (ICON_SIZE * scale) / 2;
  return ICONS[icon].map((p) => path(transformPath(p.d, scale, center.x - half, center.y - half), p.fill));
}

function drawChart(chartType: "bar" | "line", values: number[], center: { x: number; y: number }, scale: number): DrawablePath[] {
  const w = 200 * scale;
  const h = 150 * scale;
  const left = center.x - w / 2;
  const base = center.y + h / 2;
  const top = center.y - h / 2;
  const max = Math.max(...values.map((v) => Math.max(v, 0)), 1);
  const out: DrawablePath[] = [path(`M ${left} ${top} V ${base} H ${left + w}`)];
  const step = (w - 20 * scale) / values.length;
  const r = (n: number) => Math.round(n * 100) / 100;

  if (chartType === "bar") {
    values.forEach((v, i) => {
      const x0 = r(left + 12 * scale + i * step);
      const x1 = r(x0 + step * 0.6);
      const y = r(base - (Math.max(v, 0) / max) * (h - 12 * scale));
      out.push(path(`M ${x0} ${base} V ${y} H ${x1} V ${base}`, "#9FD3B4"));
    });
  } else {
    const points = values.map((v, i) => {
      const x = r(left + 12 * scale + i * step + step * 0.3);
      const y = r(base - (Math.max(v, 0) / max) * (h - 12 * scale));
      return `${x} ${y}`;
    });
    out.push(path(`M ${points.join(" L ")}`));
  }
  return out;
}

function drawArrow(from: { x: number; y: number }, to: { x: number; y: number }): DrawablePath[] {
  const dir = Math.sign(to.x - from.x) || 1;
  const ax = from.x + dir * 95;
  const bx = to.x - dir * 95;
  const y = (from.y + to.y) / 2;
  const mid = (ax + bx) / 2;
  return [
    path(`M ${ax} ${from.y} Q ${mid} ${y - 60} ${bx} ${to.y - 4}`),
    path(`M ${bx - dir * 18} ${to.y - 20} L ${bx + dir} ${to.y - 4} L ${bx - dir * 22} ${to.y + 6}`),
  ];
}

/** Devuelve los trazos de cada beat de la escena, indexados por beat.id. */
export function resolveSceneAssets(scene: Scene): Record<string, DrawablePath[]> {
  const assets: Record<string, DrawablePath[]> = {};
  const positions = new Map<string, { x: number; y: number }>();
  const usedSlots = new Set<Slot>();

  const place = (beat: Beat) => {
    let slot = beat.slot;
    if (usedSlots.has(slot)) slot = FALLBACK_ORDER.find((s) => !usedSlots.has(s)) ?? slot;
    usedSlots.add(slot);
    const center = SLOT_CENTERS[slot];
    positions.set(beat.id, center);
    return { center, scale: slot === "full" ? 1.6 : 1 };
  };

  // Primero todo lo que no es flecha, para conocer las posiciones de origen y destino.
  for (const beat of scene.beats) {
    const v = beat.visual;
    if (v.kind === "arrow") continue;
    const { center, scale } = place(beat);
    switch (v.kind) {
      case "icon":
        assets[beat.id] = drawIcon(iconFor(v.query, "idea"), center, scale);
        break;
      case "illustration":
        assets[beat.id] = drawIcon(iconFor(v.prompt, "idea"), center, scale);
        break;
      case "text":
        assets[beat.id] = drawIcon(iconFor(v.text, "cartel"), center, scale);
        break;
      case "chart":
        assets[beat.id] = drawChart(v.chartType, v.values, center, scale);
        break;
    }
  }

  for (const beat of scene.beats) {
    const v = beat.visual;
    if (v.kind !== "arrow") continue;
    const from = positions.get(v.fromBeat) ?? SLOT_CENTERS.left;
    const to = positions.get(v.toBeat) ?? SLOT_CENTERS.right;
    assets[beat.id] = drawArrow(from, to);
  }

  return assets;
}
