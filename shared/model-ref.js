/**
 * shared/model-ref.js — 模型引用复合键工具
 *
 * (provider, id) 是模型的唯一标识。
 * 运行时所有查找 / 比较 / 持久化**必须**用完整 {id, provider}。
 *
 * 纪律：
 *   - `findModel` / `modelRefEquals` / `modelRefKey` — 严格。任一边缺 provider 抛错或返 null/false，**不做按 id 降级**。
 *   - `parseModelRef` — 宽松解析器。接受三种形态（{id,provider} 对象 / "provider/id" 字符串 / 裸 "id" 字符串），
 *     返回 {id, provider}，provider 可能为 ""。**仅用于 UI 展示层或反序列化入口**（其后要经过 requireModelRef 校验）。
 *   - `requireModelRef(ref)` — 严格校验。任一缺失抛错，非 UI 层调用链应统一走这个。
 *
 * 本模块不再接受"通过 id 查 provider"之类的智能猜测——这类推断一律放在
 * migrations.js（启动期一次性迁移）或 UI 选择层（带 provider 上下文的点击事件）。
 */

/**
 * 宽松解析：把任意历史格式规整成 {id, provider}。
 *
 * - {id, provider} 对象直通（缺字段保留 ""）
 * - "provider/id" 字符串按首个 / 拆分
 * - 裸 "id" 字符串返 {id, provider: ""}（调用方必须自己补 provider 或校验）
 * - null / undefined / 空串 → null
 *
 * ⚠ 本函数的返回值允许 provider 为空。**只用于 UI 展示层或迁移入口**。
 * 运行时查找和比较**必须**用 requireModelRef 包一次。
 */
export function parseModelRef(ref) {
  if (!ref) return null;
  if (typeof ref === "object") {
    if (!ref.id) return null;
    return { id: ref.id, provider: ref.provider || "" };
  }
  if (typeof ref !== "string") return null;
  const s = ref.trim();
  if (!s) return null;
  const slashIdx = s.indexOf("/");
  if (slashIdx > 0 && slashIdx < s.length - 1) {
    return { provider: s.slice(0, slashIdx), id: s.slice(slashIdx + 1) };
  }
  return { id: s, provider: "" };
}

/**
 * 严格校验：返回保证 id 和 provider 都非空的 {id, provider}，否则抛错。
 *
 * 运行时（非 UI、非迁移入口）一律用这个。抛错就代表上游逻辑丢了 provider——
 * 要修的是那里，不要在这里兜底。
 */
export function requireModelRef(ref) {
  const parsed = parseModelRef(ref);
  if (!parsed || !parsed.id || !parsed.provider) {
    throw new Error(`requireModelRef: missing id or provider (got ${JSON.stringify(ref)})`);
  }
  return parsed;
}

/**
 * 在 availableModels 中用复合键精确查找。
 *
 * 必须同时提供 id 和 provider，二者任一缺失抛错。
 * 找不到返回 null。**不做任何按 id 降级查找。**
 *
 * 兼容：`findModel(available, {id, provider})` 直接传对象也行。
 */
export function findModel(available, id, provider) {
  if (!available) return null;
  if (typeof id === "object" && id !== null) {
    return findModel(available, id.id, id.provider);
  }
  if (!id || !provider) {
    throw new Error(`findModel: id and provider both required (got id=${id}, provider=${provider})`);
  }
  return available.find(m => m.id === id && m.provider === provider) || null;
}

/**
 * 两个模型引用是否相等（严格复合键比较）。
 *
 * 任一边 id 或 provider 缺失视为不等，不做降级。
 */
export function modelRefEquals(a, b) {
  if (!a || !b) return false;
  if (!a.id || !b.id || !a.provider || !b.provider) return false;
  return a.id === b.id && a.provider === b.provider;
}

/**
 * 构造字符串形式的复合键（用于 Map key、React key、URL 等）。
 * 格式：`${provider}/${id}`
 *
 * provider 或 id 缺失时抛错。
 */
export function modelRefKey(ref) {
  if (!ref?.id || !ref?.provider) {
    throw new Error(`modelRefKey: missing id or provider (got ${JSON.stringify(ref)})`);
  }
  return `${ref.provider}/${ref.id}`;
}
