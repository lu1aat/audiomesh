/**
 * Looks for the waterfall, as plain data: a colour ramp (level 0..1 to colour) and the
 * colours of everything drawn over it. Adding a theme = one entry in THEMES.
 * Channel boxes keep their meaning on every theme: red = our frame, yellow = input
 * overloaded, blue = selected.
 */

type Rgb = readonly [number, number, number];

/** Colours of a channel box in one state: translucent fill, border and label. */
export interface BoxColours {
  readonly fill: string;
  readonly stroke: string;
  readonly text: string;
}

export interface WaterfallTheme {
  readonly id: string;
  readonly label: string;
  /** Colour ramp, stops from 0 (quiet) to 1 (loud). */
  readonly stops: readonly (readonly [number, Rgb])[];
  /** Canvas background behind everything, and the axis strip. */
  readonly canvasBg: string;
  readonly axisBg: string;
  readonly axisText: string;
  /** The spectrum line, the slot boundary lines and their time labels, the reference-tone triangles. */
  readonly spectrumLine: string;
  readonly slotLine: string;
  readonly slotText: string;
  readonly marker: string;
  readonly idle: BoxColours;
  readonly sending: BoxColours;
  readonly overload: BoxColours;
  readonly selected: BoxColours;
  /** The flash of a decoded frame, as "r, g, b": white on dark themes, black on a light one. */
  readonly flash: string;
}

const DARK_BOXES = {
  idle: { fill: 'rgba(255, 255, 255, 0.07)', stroke: 'rgba(255, 255, 255, 0.28)', text: 'rgba(255, 255, 255, 0.75)' },
  sending: { fill: 'rgba(240, 70, 70, 0.4)', stroke: 'rgba(255, 110, 110, 1)', text: '#ffb3b3' },
  overload: { fill: 'rgba(235, 200, 60, 0.35)', stroke: 'rgba(245, 210, 80, 1)', text: '#ffe9a8' },
  selected: { fill: 'rgba(90, 180, 255, 0.28)', stroke: 'rgba(120, 200, 255, 0.95)', text: '#bfe3ff' },
} as const;

const DARK_CHROME = {
  canvasBg: '#0b0d12',
  axisBg: '#14171d',
  axisText: '#9aa3b2',
  spectrumLine: '#e6d75a',
  slotLine: 'rgba(255, 255, 255, 0.6)',
  slotText: 'rgba(255, 255, 255, 0.85)',
  marker: '#e6d75a',
  flash: '255, 255, 255',
  ...DARK_BOXES,
} as const;

export const THEMES: readonly WaterfallTheme[] = [
  {
    id: 'sdr',
    label: 'Classic SDR (default)',
    stops: [[0, [0, 0, 40]], [0.2, [0, 40, 160]], [0.4, [0, 170, 200]], [0.6, [40, 200, 60]], [0.8, [240, 220, 40]], [1, [230, 30, 20]]],
    ...DARK_CHROME,
    spectrumLine: '#ffffff',
    marker: '#ffffff',
  },
  {
    id: 'viridis',
    label: 'Viridis',
    // Perceptually uniform, rises in lightness: brighter = stronger.
    stops: [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]],
    ...DARK_CHROME,
  },
  {
    id: 'grey',
    label: 'Greyscale',
    stops: [[0, [0, 0, 0]], [1, [255, 255, 255]]],
    ...DARK_CHROME,
    spectrumLine: '#ffd84a',
  },
  {
    id: 'phosphor',
    label: 'Green phosphor',
    stops: [[0, [0, 6, 0]], [0.5, [0, 120, 20]], [1, [170, 255, 170]]],
    ...DARK_CHROME,
    canvasBg: '#020a02',
    axisBg: '#061206',
    axisText: '#6fbf6f',
    spectrumLine: '#9dff9d',
    slotLine: 'rgba(160, 255, 160, 0.55)',
    slotText: 'rgba(170, 255, 170, 0.9)',
    marker: '#9dff9d',
  },
  {
    id: 'sun',
    label: 'High contrast (sunlight): dark signal on white',
    stops: [[0, [255, 255, 255]], [0.35, [255, 214, 120]], [0.65, [220, 80, 20]], [1, [20, 0, 40]]],
    canvasBg: '#ffffff',
    axisBg: '#e6e6e6',
    axisText: '#000000',
    spectrumLine: '#000000',
    slotLine: 'rgba(0, 0, 0, 0.7)',
    slotText: '#000000',
    marker: '#000000',
    flash: '0, 0, 0',
    idle: { fill: 'rgba(0, 0, 0, 0.06)', stroke: 'rgba(0, 0, 0, 0.45)', text: '#000000' },
    sending: { fill: 'rgba(214, 40, 40, 0.4)', stroke: '#b00020', text: '#7a0010' },
    overload: { fill: 'rgba(240, 190, 0, 0.5)', stroke: '#8a6a00', text: '#4d3900' },
    selected: { fill: 'rgba(20, 110, 230, 0.3)', stroke: '#0b5cd5', text: '#073d91' },
  },
];

export const DEFAULT_THEME_ID = 'sdr';

export function themeById(id: string): WaterfallTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

export const LUT_SIZE = 256;

/** The ramp baked into a LUT_SIZE x 3 table: the waterfall colours 1024 cells every frame, too many for interpolating each. */
export function buildLut(theme: WaterfallTheme): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  const stops = theme.stops;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++;
    const [t0, c0] = stops[k]!;
    const [t1, c1] = stops[k + 1]!;
    const f = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = c0[c]! + (c1[c]! - c0[c]!) * f;
  }
  return lut;
}

export function themeBackground(theme: WaterfallTheme): string {
  return `rgb(${theme.stops[0]![1].join(',')})`;
}
