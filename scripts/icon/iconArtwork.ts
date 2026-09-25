/**
 * MeetPilot 的 icon：四根前傾的語音條（短、高、中、短）落進一顆紅點，白底。
 * 讀法是「話說出來，被記下來」；紅點是唯一的強調色，也是「正在記」。
 *
 * 這裡只有純函式：排版、產 SVG、把 PNG 打包成 .ico。渲染與寫檔在 `scripts/buildIcons.ts`。
 *
 * 尺寸分兩種畫法：
 * - 48px 以上從 1024 的向量縮。macOS 版照 Apple 格線（824 方塊置中、外面透明、不加陰影），
 *   macOS 26 對形狀不合的 icon 會套灰底框；Windows 版方塊撐滿畫布。
 * - 32px 以下照像素格手排：條寬、間隙、條的上下緣都是整數像素，不然邊緣落在半格上會糊。
 *   Windows 16、24px 與 macOS 16、32px 改直條，前傾的細條在這些尺寸會被混色成灰。
 */

export const CORAL = '#FF5A4E';
export const INK = '#141416';
/** 條高比例，最後落進點 */
export const RHYTHM = [300, 560, 400, 230] as const;
/** 前傾角度（度） */
export const LEAN = 12;

const BG_GRADIENT =
  '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F0F0F3"/></linearGradient>';
// 白方塊放在淺色背景上會看不見輪廓，加一道很淡的邊
const EDGE = 'stroke="#000" stroke-opacity="0.09"';

export interface GlyphSpec {
  heights: readonly number[];
  barWidth: number;
  gap: number;
  /** 最後一根條到點的間隙 */
  dotGap: number;
  dotRadius: number;
  cx: number;
  cy: number;
  lean: number;
}

export interface GlyphLayout {
  bars: { x: number; y: number; width: number; height: number }[];
  dot: { cx: number; cy: number; r: number };
  lean: number;
  cy: number;
}

export function layoutGlyph(spec: GlyphSpec): GlyphLayout {
  const { heights, barWidth, gap, dotGap, dotRadius, cx, cy, lean } = spec;
  const total = heights.length * barWidth + (heights.length - 1) * gap + dotGap + 2 * dotRadius;
  let x = cx - total / 2;
  const bars = heights.map((height) => {
    const bar = { x, y: cy - height / 2, width: barWidth, height };
    x += barWidth + gap;
    return bar;
  });
  x += dotGap - gap;
  return { bars, dot: { cx: x + dotRadius, cy, r: dotRadius }, lean, cy };
}

function num(n: number): string {
  return Number(n.toFixed(3)).toString();
}

export function glyphSvg(layout: GlyphLayout, fg: string, dot: string): string {
  const k = Math.tan((layout.lean * Math.PI) / 180);
  // 條各自繞垂直中心 cy 前傾；點不套變形，保持正圓
  const skew = layout.lean ? ` transform="matrix(1 0 ${num(-k)} 1 ${num(k * layout.cy)} 0)"` : '';
  const bars = layout.bars.map((b) =>
    `<rect x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" rx="${num(b.width / 2)}" fill="${fg}"${skew}/>`,
  );
  const { cx, cy, r } = layout.dot;
  // 半徑 1px 的圓會被混色成粉紅，直接畫成實心方塊
  const dotEl = r <= 1
    ? `<rect x="${num(cx - r)}" y="${num(cy - r)}" width="${num(2 * r)}" height="${num(2 * r)}" fill="${dot}"/>`
    : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${dot}"/>`;
  return bars.join('') + dotEl;
}

function svg(size: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<defs>${BG_GRADIENT}</defs>${body}</svg>`;
}

/** 超橢圓 n=5：在 45° 的位置跟 Apple 22.37% 連續圓角差不到 0.2% */
export function squirclePath(halfSize: number, n = 5, steps = 360, c = 512): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const x = Math.cos(t);
    const y = Math.sin(t);
    pts.push(`${num(c + halfSize * Math.sign(x) * Math.abs(x) ** (2 / n))},${num(c + halfSize * Math.sign(y) * Math.abs(y) ** (2 / n))}`);
  }
  return `M${pts.join(' L')}Z`;
}

/** 1024 畫布的原稿：條寬 100、間隙 46，整組縮 scale；往左移 10 抵銷右端紅點的視覺重量 */
export function largeGlyph(scale: number): GlyphLayout {
  return layoutGlyph({
    heights: RHYTHM.map((h) => h * scale),
    barWidth: 100 * scale,
    gap: 46 * scale,
    dotGap: 46 * scale,
    dotRadius: 60 * scale,
    cx: 512 - 10 * scale,
    cy: 512,
    lean: LEAN,
  });
}

function largeIcon(halfSize: number, scale: number): string {
  return svg(1024, `<path d="${squirclePath(halfSize)}" fill="url(#bg)" ${EDGE} stroke-width="3"/>` +
    glyphSvg(largeGlyph(scale), INK, CORAL));
}

/** macOS：Apple 格線 824 方塊，不加陰影（系統自己加光影） */
export const macIconSvg = (): string => largeIcon(412, 0.8);
/** Windows 48px 以上：方塊撐滿畫布 */
export const winIconSvg = (): string => largeIcon(500, 0.96);

export interface PixelSpec {
  size: number;
  heights: readonly number[];
  barWidth: number;
  gap: number;
  dotGap: number;
  dotRadius: number;
  lean: number;
}

/** 有底色方塊的小尺寸；inset 是方塊離畫布邊緣的格數（Windows 撐滿是 0，macOS 照 Apple 格線留白） */
export interface FramedSpec extends PixelSpec {
  inset: number;
  radius: number;
  edge: boolean;
}

// 條高都取偶數，中心在整數格上時上下緣才會落在整數像素
export const SMALL_ICONS: Record<16 | 24 | 32, FramedSpec> = {
  32: { size: 32, inset: 0, radius: 7, heights: [10, 18, 12, 8], barWidth: 3, gap: 2, dotGap: 2, dotRadius: 2, lean: LEAN, edge: true },
  24: { size: 24, inset: 0, radius: 5, heights: [8, 14, 10, 6], barWidth: 2, gap: 2, dotGap: 2, dotRadius: 2, lean: 0, edge: true },
  // 16px 左右只剩 1px，邊線會跟最外側的條黏在一起，所以不畫
  16: { size: 16, inset: 0, radius: 3.5, heights: [6, 10, 8, 4], barWidth: 2, gap: 1, dotGap: 1, dotRadius: 1, lean: 0, edge: false },
};

// macOS 的 16、32px（Finder 列表與側欄）：方塊照 Apple 格線約 81%（16px 本體 14 格、32px 本體 26 格），
// 裡面放不下 3px 的前傾條，兩個都用直條
export const MAC_SMALL_ICONS: Record<16 | 32, FramedSpec> = {
  32: { size: 32, inset: 3, radius: 6, heights: [8, 14, 10, 6], barWidth: 2, gap: 2, dotGap: 2, dotRadius: 2, lean: 0, edge: true },
  16: { size: 16, inset: 1, radius: 3, heights: [6, 10, 8, 4], barWidth: 1, gap: 1, dotGap: 1, dotRadius: 1, lean: 0, edge: true },
};

/** macOS 選單列 template：只用黑色與透明，系統依深淺模式上色 */
export const TRAY_ICONS: Record<16 | 32, PixelSpec> = {
  32: { size: 32, heights: [12, 22, 16, 10], barWidth: 3, gap: 2, dotGap: 2, dotRadius: 3, lean: LEAN },
  16: { size: 16, heights: [6, 12, 8, 4], barWidth: 2, gap: 1, dotGap: 1, dotRadius: 1, lean: 0 },
};

export function pixelGlyph(spec: PixelSpec): GlyphLayout {
  return layoutGlyph({ ...spec, cx: spec.size / 2, cy: spec.size / 2 });
}

function framedIconSvg(spec: FramedSpec): string {
  // 邊線畫在半像素上才會落在方塊最外一圈像素裡；沒有邊線時底色要鋪滿，不然最外圈只蓋一半會發灰
  const inset = spec.inset + (spec.edge ? 0.5 : 0);
  const line = spec.edge ? ` ${EDGE} stroke-width="1"` : '';
  const side = spec.size - 2 * inset;
  const back = `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${spec.radius}" fill="url(#bg)"${line}/>`;
  return svg(spec.size, back + glyphSvg(pixelGlyph(spec), INK, CORAL));
}

export const smallIconSvg = (size: 16 | 24 | 32): string => framedIconSvg(SMALL_ICONS[size]);

/** .icns 各尺寸的來源：16、32px 用像素格版，其餘從 1024 縮 */
export function macIconSourceSvg(size: number): string {
  return size === 16 || size === 32 ? framedIconSvg(MAC_SMALL_ICONS[size]) : macIconSvg();
}

export function traySvg(size: 16 | 32): string {
  return svg(size, glyphSvg(pixelGlyph(TRAY_ICONS[size]), '#000000', '#000000'));
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export function icoSourceSvg(size: (typeof ICO_SIZES)[number]): string {
  return size === 16 || size === 24 || size === 32 ? smallIconSvg(size) : winIconSvg();
}

/** iconutil 的 .iconset 檔名對像素尺寸 */
export const ICONSET: Record<string, number> = {
  'icon_16x16.png': 16,
  'icon_16x16@2x.png': 32,
  'icon_32x32.png': 32,
  'icon_32x32@2x.png': 64,
  'icon_128x128.png': 128,
  'icon_128x128@2x.png': 256,
  'icon_256x256.png': 256,
  'icon_256x256@2x.png': 512,
  'icon_512x512.png': 512,
  'icon_512x512@2x.png': 1024,
};

/**
 * PNG 內嵌格式的 .ico（Vista 起支援）。每筆目錄 16 bytes：寬、高（256 記成 0）、
 * 調色盤數、保留、色彩平面、位元深度、資料長度、資料位移。
 */
export function packIco(images: { size: number; png: Buffer }[]): Buffer {
  if (images.length === 0) throw new Error('packIco：沒有任何圖');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    if (size < 1 || size > 256) throw new Error(`packIco：${size}px 超出 .ico 的 1–256`);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size % 256, 0);
    entry.writeUInt8(size % 256, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

export interface RenderJob { name: string; svg: string; size: number }

/**
 * `scripts/buildIcons.ts` 要渲染的全部圖：`mac-<px>` 組 .icns、`win-<px>` 組 .ico、`tray-*` 是托盤圖。
 * 哪個尺寸用哪一版圖只在這裡決定，測試才守得到接線。
 */
export function renderPlan(): RenderJob[] {
  return [
    ...[...new Set(Object.values(ICONSET))].map((size) => ({ name: `mac-${size}`, svg: macIconSourceSvg(size), size })),
    ...ICO_SIZES.map((size) => ({ name: `win-${size}`, svg: icoSourceSvg(size), size })),
    { name: 'tray-16', svg: traySvg(16), size: 16 },
    { name: 'tray-32', svg: traySvg(32), size: 32 },
    { name: 'tray-win', svg: smallIconSvg(32), size: 32 },
  ];
}
