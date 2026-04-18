/**
 * block-renderers.ts — Content Block 渲染注册表
 *
 * 物种 B（RichBlock）的渲染组件通过注册表分发，
 * 新增 block 类型只需加一行注册。
 */
import type { FC } from 'react';

export const BLOCK_RENDERERS: Record<string, FC<{ block: any }>> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

export function registerBlockRenderer(type: string, component: FC<{ block: any }>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  BLOCK_RENDERERS[type] = component;
}
