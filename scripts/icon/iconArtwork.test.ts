import { describe, expect, it } from 'vitest';
import {
  glyphSvg, ICO_SIZES, ICONSET, largeGlyph, LEAN, MAC_SMALL_ICONS, packIco, pixelGlyph, renderPlan, SMALL_ICONS, TRAY_ICONS,
  type PixelSpec,
} from './iconArtwork';

// inset：底色方塊離畫布邊緣的格數，托盤沒有方塊是 0
const pixelSpecs: [string, PixelSpec, number][] = [
  ...Object.values(SMALL_ICONS).map((s): [string, PixelSpec, number] => [`windows ${s.size}px`, s, s.inset]),
  ...Object.values(MAC_SMALL_ICONS).map((s): [string, PixelSpec, number] => [`macOS ${s.size}px`, s, s.inset]),
  ...Object.values(TRAY_ICONS).map((s): [string, PixelSpec, number] => [`tray ${s.size}px`, s, 0]),
];

describe('小尺寸照像素格排', () => {
  // 查的是斜切前的外框；前傾的條（Windows 32、tray 32）渲染後邊緣本來就是斜的
  it.each(pixelSpecs)('%s：條與點排版時的外框落在整數像素上', (_, spec) => {
    const { bars, dot } = pixelGlyph(spec);
    for (const b of bars) {
      for (const v of [b.x, b.y, b.width, b.height]) expect(Number.isInteger(v)).toBe(true);
    }
    expect(Number.isInteger(dot.cx - dot.r)).toBe(true);
    expect(Number.isInteger(dot.cy - dot.r)).toBe(true);
    expect(Number.isInteger(2 * dot.r)).toBe(true);
  });

  it.each(pixelSpecs)('%s：前傾之後離方塊左右仍至少留 1px', (_, spec, inset) => {
    const { bars, dot, cy, lean } = pixelGlyph(spec);
    const k = Math.tan((lean * Math.PI) / 180);
    // 條繞 cy 斜切：上緣往右移、下緣往左移
    const left = Math.min(...bars.map((b) => b.x + k * (cy - (b.y + b.height))), dot.cx - dot.r);
    const right = Math.max(...bars.map((b) => b.x + b.width + k * (cy - b.y)), dot.cx + dot.r);
    expect(left).toBeGreaterThanOrEqual(inset + 1);
    expect(right).toBeLessThanOrEqual(spec.size - inset - 1);
  });
});

describe('renderPlan', () => {
  const plan = renderPlan();
  const viewBox = (svg: string) => svg.match(/viewBox="0 0 (\d+) \d+"/)?.[1];

  it('.icns 與 .ico 要的每個尺寸都有一張，名字不重複', () => {
    const names = plan.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const size of new Set(Object.values(ICONSET))) expect(names).toContain(`mac-${size}`);
    for (const size of ICO_SIZES) expect(names).toContain(`win-${size}`);
  });

  it('32px 以下用照像素格排的圖，48px 以上從 1024 縮', () => {
    for (const job of plan) {
      expect(viewBox(job.svg)).toBe(String(job.size <= 32 ? job.size : 1024));
    }
  });

  it('macOS 的 16、32px 方塊照 Apple 格線內縮，不用 Windows 撐滿的那版', () => {
    for (const size of [16, 32] as const) {
      const job = plan.find((j) => j.name === `mac-${size}`);
      // 第一個 rect 是底色方塊，有邊線時畫在半像素上
      expect(job?.svg.match(/<rect x="([\d.]+)"/)?.[1]).toBe(String(MAC_SMALL_ICONS[size].inset + 0.5));
    }
  });
});

describe('glyphSvg', () => {
  it('條前傾、點保持正圓', () => {
    const out = glyphSvg(largeGlyph(0.8), '#000', '#f00');
    const bars = out.match(/<rect [^>]*>/g) ?? [];
    expect(bars).toHaveLength(4);
    for (const bar of bars) expect(bar).toContain('transform="matrix(1 0 -0.213 1');
    expect(out).toMatch(/<circle cx="[\d.]+" cy="512" r="48" fill="#f00"\/>$/);
    expect(LEAN).toBe(12);
  });

  it('半徑 1px 的點畫成實心方塊，不畫圓', () => {
    const out = glyphSvg(pixelGlyph(SMALL_ICONS[16]), '#000', '#f00');
    expect(out).not.toContain('<circle');
    expect(out).toMatch(/<rect x="13" y="7" width="2" height="2" fill="#f00"\/>$/);
  });
});

describe('packIco', () => {
  it('標頭、目錄、資料依序排好；256px 記成 0', () => {
    const a = Buffer.from([1, 2, 3]);
    const b = Buffer.from([4, 5]);
    const ico = packIco([{ size: 16, png: a }, { size: 256, png: b }]);
    expect([...ico]).toEqual([
      0, 0, 1, 0, 2, 0,
      16, 16, 0, 0, 1, 0, 32, 0, 3, 0, 0, 0, 38, 0, 0, 0,
      0, 0, 0, 0, 1, 0, 32, 0, 2, 0, 0, 0, 41, 0, 0, 0,
      1, 2, 3,
      4, 5,
    ]);
  });

  it('超出 1–256 或沒有圖就拒絕', () => {
    expect(() => packIco([{ size: 512, png: Buffer.from([0]) }])).toThrow('512px');
    expect(() => packIco([])).toThrow('沒有任何圖');
  });
});
