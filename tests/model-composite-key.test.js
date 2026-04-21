import { describe, it, expect } from "vitest";
import { parseModelRef, findModel, modelRefEquals, modelRefKey, requireModelRef } from "../shared/model-ref.js";

describe("Model composite key", () => {
  const models = [
    { id: "minimax-2.5", provider: "dashscope", name: "MiniMax 2.5 (DashScope)" },
    { id: "minimax-2.5", provider: "minimax", name: "MiniMax 2.5" },
    { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    { id: "MiniMax/MiniMax-M2.7", provider: "dashscope", name: "MiniMax M2.7" },
  ];

  describe("findModel", () => {
    it("精确匹配 (provider, id)", () => {
      const m = findModel(models, "minimax-2.5", "dashscope");
      expect(m.provider).toBe("dashscope");
    });

    it("同 ID 不同 provider 返回正确的", () => {
      const d = findModel(models, "minimax-2.5", "dashscope");
      const m = findModel(models, "minimax-2.5", "minimax");
      expect(d.provider).toBe("dashscope");
      expect(m.provider).toBe("minimax");
    });

    it("缺 provider 时抛错（严格契约，不按 id 降级）", () => {
      expect(() => findModel(models, "gpt-4o")).toThrow(/provider/);
      expect(() => findModel(models, "gpt-4o", "")).toThrow(/provider/);
      expect(() => findModel(models, { id: "gpt-4o" })).toThrow(/provider/);
    });

    it("找不到返回 null（带 provider）", () => {
      expect(findModel(models, "nonexistent", "openai")).toBeNull();
    });

    it("null/empty 输入：id 缺失抛错，available 为 null 返 null", () => {
      expect(findModel(null, "gpt-4o", "openai")).toBeNull();
      expect(() => findModel(models, null)).toThrow(/id/);
      expect(() => findModel(models, "")).toThrow(/id/);
    });

    it("{id, provider} 对象作为第二个参数", () => {
      const m = findModel(models, { id: "minimax-2.5", provider: "dashscope" });
      expect(m.provider).toBe("dashscope");
    });

    it("id 带 / 的复合 ID 正常匹配（Vendor/model 格式也视作 id 一部分）", () => {
      const m = findModel(models, "MiniMax/MiniMax-M2.7", "dashscope");
      expect(m.provider).toBe("dashscope");
    });
  });

  describe("parseModelRef", () => {
    it("对象格式 {id, provider}", () => {
      const r = parseModelRef({ id: "gpt-4o", provider: "openai" });
      expect(r).toEqual({ id: "gpt-4o", provider: "openai" });
    });

    it("'provider/id' 复合字符串", () => {
      const r = parseModelRef("openai/gpt-4o");
      expect(r).toEqual({ id: "gpt-4o", provider: "openai" });
    });

    it("裸字符串 → {id, provider: ''}（UI 展示降级，运行期必须走 requireModelRef）", () => {
      const r = parseModelRef("gpt-4o");
      expect(r).toEqual({ id: "gpt-4o", provider: "" });
    });

    it("null/undefined → null", () => {
      expect(parseModelRef(null)).toBeNull();
      expect(parseModelRef(undefined)).toBeNull();
      expect(parseModelRef("")).toBeNull();
    });

    it("对象缺 provider → provider:''", () => {
      const r = parseModelRef({ id: "gpt-4o" });
      expect(r).toEqual({ id: "gpt-4o", provider: "" });
    });
  });

  describe("requireModelRef", () => {
    it("完整对象通过", () => {
      expect(requireModelRef({ id: "gpt-4o", provider: "openai" }))
        .toEqual({ id: "gpt-4o", provider: "openai" });
    });

    it("'provider/id' 通过", () => {
      expect(requireModelRef("openai/gpt-4o"))
        .toEqual({ id: "gpt-4o", provider: "openai" });
    });

    it("裸 id 抛错", () => {
      expect(() => requireModelRef("gpt-4o")).toThrow(/provider/);
    });

    it("对象缺 provider 抛错", () => {
      expect(() => requireModelRef({ id: "gpt-4o" })).toThrow(/provider/);
    });
  });

  describe("modelRefEquals", () => {
    it("同 provider 同 id 相等", () => {
      expect(modelRefEquals(
        { id: "gpt-4o", provider: "openai" },
        { id: "gpt-4o", provider: "openai" }
      )).toBe(true);
    });

    it("同 id 不同 provider 不等", () => {
      expect(modelRefEquals(
        { id: "minimax-2.5", provider: "dashscope" },
        { id: "minimax-2.5", provider: "minimax" }
      )).toBe(false);
    });

    it("一方无 provider 不等（严格契约，不降级）", () => {
      expect(modelRefEquals(
        { id: "gpt-4o", provider: "" },
        { id: "gpt-4o", provider: "openai" }
      )).toBe(false);
    });

    it("null 输入返回 false", () => {
      expect(modelRefEquals(null, { id: "gpt-4o", provider: "openai" })).toBe(false);
      expect(modelRefEquals({ id: "gpt-4o", provider: "openai" }, null)).toBe(false);
    });
  });

  describe("modelRefKey", () => {
    it("生成 'provider/id' 字符串", () => {
      expect(modelRefKey({ id: "gpt-4o", provider: "openai" })).toBe("openai/gpt-4o");
    });

    it("缺 provider 或 id 抛错", () => {
      expect(() => modelRefKey({ id: "gpt-4o" })).toThrow(/provider/);
      expect(() => modelRefKey({ provider: "openai" })).toThrow(/id/);
      expect(() => modelRefKey(null)).toThrow();
    });
  });
});
