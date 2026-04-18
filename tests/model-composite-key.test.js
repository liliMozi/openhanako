import { describe, it, expect } from "vitest";
import { parseModelRef, findModel, modelRefEquals } from "../shared/model-ref.js";

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

    it("无 provider 时 fallback 到第一个匹配（兼容旧数据）", () => {
      const m = findModel(models, "gpt-4o");
      expect(m.provider).toBe("openai");
    });

    it("找不到返回 null", () => {
      expect(findModel(models, "nonexistent", "openai")).toBeNull();
    });

    it("DashScope Vendor/model 格式 ID 正常匹配", () => {
      const m = findModel(models, "MiniMax/MiniMax-M2.7", "dashscope");
      expect(m.provider).toBe("dashscope");
    });

    it("null/empty 输入返回 null", () => {
      expect(findModel(models, null)).toBeNull();
      expect(findModel(models, "")).toBeNull();
      expect(findModel(null, "gpt-4o")).toBeNull();
    });

    it("{id, provider} 对象作为第二个参数", () => {
      const m = findModel(models, { id: "minimax-2.5", provider: "dashscope" });
      expect(m.provider).toBe("dashscope");
    });

    it("{id} 对象无 provider 时 fallback 到第一个匹配", () => {
      const m = findModel(models, { id: "gpt-4o" });
      expect(m.provider).toBe("openai");
    });

    it("{id, provider} 对象 + 第三个参数 provider 时，对象的 provider 优先", () => {
      const m = findModel(models, { id: "minimax-2.5", provider: "minimax" }, "dashscope");
      expect(m.provider).toBe("minimax");
    });

    it("{id} 对象无 provider 时，第三个参数补充 provider", () => {
      const m = findModel(models, { id: "minimax-2.5" }, "dashscope");
      expect(m.provider).toBe("dashscope");
    });
  });

  describe("parseModelRef", () => {
    it("对象格式 {id, provider}", () => {
      const r = parseModelRef({ id: "gpt-4o", provider: "openai" });
      expect(r).toEqual({ id: "gpt-4o", provider: "openai" });
    });

    it("裸字符串", () => {
      const r = parseModelRef("gpt-4o");
      expect(r).toEqual({ id: "gpt-4o", provider: "" });
    });

    it("null/undefined", () => {
      expect(parseModelRef(null)).toEqual({ id: "", provider: "" });
      expect(parseModelRef(undefined)).toEqual({ id: "", provider: "" });
    });

    it("对象缺 provider", () => {
      const r = parseModelRef({ id: "gpt-4o" });
      expect(r).toEqual({ id: "gpt-4o", provider: "" });
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

    it("一方无 provider 时退化为 ID 比较（兼容旧数据）", () => {
      expect(modelRefEquals(
        { id: "gpt-4o", provider: "" },
        { id: "gpt-4o", provider: "openai" }
      )).toBe(true);
    });

    it("null 输入返回 false", () => {
      expect(modelRefEquals(null, { id: "gpt-4o", provider: "openai" })).toBe(false);
      expect(modelRefEquals({ id: "gpt-4o", provider: "openai" }, null)).toBe(false);
    });
  });
});
