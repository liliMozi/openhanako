import { describe, expect, it } from 'vitest';
import {
  zoomAtPoint,
  computeFitScale,
  clamp,
  computeCenteredTransform,
} from '../../../../components/shared/MediaViewer/use-media-transform';

describe('clamp', () => {
  it('在范围内不变', () => expect(clamp(5, 1, 10)).toBe(5));
  it('低于 min 取 min', () => expect(clamp(-1, 1, 10)).toBe(1));
  it('高于 max 取 max', () => expect(clamp(99, 1, 10)).toBe(10));
});

describe('computeFitScale', () => {
  it('图片小于视口 → fit 填满但不超过 0.9', () => {
    // viewport 1000x800, natural 500x400, 基础比 0.9 * min(1000/500, 800/400) = 0.9 * 2 = 1.8
    expect(computeFitScale({ w: 500, h: 400 }, { w: 1000, h: 800 })).toBeCloseTo(1.8);
  });
  it('图片大于视口 → fit 缩小', () => {
    // viewport 800x600, natural 2000x1500, 0.9 * min(800/2000, 600/1500) = 0.9 * 0.4 = 0.36
    expect(computeFitScale({ w: 2000, h: 1500 }, { w: 800, h: 600 })).toBeCloseTo(0.36);
  });
  it('natural 为 null 返回 1', () => {
    expect(computeFitScale(null, { w: 800, h: 600 })).toBe(1);
  });
});

describe('zoomAtPoint', () => {
  it('缩放前后鼠标锚点对应的图片坐标不变', () => {
    // 起始：scale=1, offset=(100,100)，鼠标点在 viewport (200, 200)
    // 该点对应图片坐标 = (200-100)/1 = (100, 100)
    const next = zoomAtPoint(
      { scale: 1, offsetX: 100, offsetY: 100 },
      { x: 200, y: 200 },
      2, // 放大到 2x
      { min: 0.1, max: 8 },
    );
    expect(next.scale).toBe(2);
    // 新 offset 应让鼠标点 (200,200) 仍对应图片 (100,100)
    // viewport(200,200) = offsetX + imageCoord * newScale → 200 = offsetX + 100*2 → offsetX = 0
    expect(next.offsetX).toBeCloseTo(0);
    expect(next.offsetY).toBeCloseTo(0);
  });

  it('超过 max 被 clamp，offset 同步按实际 newScale 修正', () => {
    const next = zoomAtPoint(
      { scale: 4, offsetX: 0, offsetY: 0 },
      { x: 100, y: 100 },
      4, // 想放 4x 到 16，但 max=8
      { min: 0.5, max: 8 },
    );
    expect(next.scale).toBe(8);
  });

  it('低于 min 被 clamp', () => {
    const next = zoomAtPoint(
      { scale: 1, offsetX: 0, offsetY: 0 },
      { x: 0, y: 0 },
      0.01,
      { min: 0.5, max: 8 },
    );
    expect(next.scale).toBe(0.5);
  });
});

describe('computeCenteredTransform', () => {
  it('把 fit 后的图片居中，再叠加用户拖动偏移', () => {
    const css = computeCenteredTransform(
      { scale: 1.8, offsetX: 10, offsetY: -5 },
      { w: 500, h: 400 },
      { w: 1000, h: 800 },
    );
    expect(css).toBe('translate(60px, 35px) scale(1.8)');
  });

  it('natural 缺失时只保留交互偏移和 scale', () => {
    const css = computeCenteredTransform(
      { scale: 1, offsetX: 12, offsetY: 24 },
      null,
      { w: 1000, h: 800 },
    );
    expect(css).toBe('translate(12px, 24px) scale(1)');
  });
});
