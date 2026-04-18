/**
 * shared/model-ref.js — 模型引用复合键工具
 *
 * (provider, id) 是模型的唯一标识。
 * 所有模型查找、比较、持久化都必须使用这些函数。
 */

/** 从混合格式解析出 {id, provider} */
export function parseModelRef(ref) {
  if (!ref) return { id: "", provider: "" };
  if (typeof ref === "object" && ref.id) {
    return { id: ref.id, provider: ref.provider || "" };
  }
  if (typeof ref === "string") return { id: ref, provider: "" };
  return { id: String(ref), provider: "" };
}

/** 在 availableModels 中用复合键查找（id 参数兼容 {id, provider} 对象） */
export function findModel(available, id, provider) {
  if (!available || !id) return null;
  // 兼容 {id, provider} 对象作为第二个参数
  if (typeof id === "object" && id.id) {
    return findModel(available, id.id, id.provider || provider);
  }
  if (provider) {
    const exact = available.find(m => m.id === id && m.provider === provider);
    if (exact) return exact;
  }
  return available.find(m => m.id === id) || null;
}

/** 两个模型引用是否相等 */
export function modelRefEquals(a, b) {
  if (!a || !b) return false;
  const ra = parseModelRef(a);
  const rb = parseModelRef(b);
  if (ra.provider && rb.provider) return ra.id === rb.id && ra.provider === rb.provider;
  return ra.id === rb.id;
}
