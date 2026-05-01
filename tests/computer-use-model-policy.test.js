import { describe, expect, it } from "vitest";
import { assertComputerUseModelSupported } from "../core/computer-use/model-policy.js";
import { COMPUTER_USE_ERRORS, ComputerUseError } from "../core/computer-use/errors.js";

describe("Computer Use model policy", () => {
  it("allows models that explicitly support image input", () => {
    expect(() => assertComputerUseModelSupported({
      id: "gpt-5.5",
      provider: "openai",
      input: ["text", "image"],
    })).not.toThrow();
  });

  it("blocks text-only models with COMPUTER_USE_REQUIRES_VISION_MODEL", () => {
    expect(() => assertComputerUseModelSupported({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      input: ["text"],
    })).toThrow(ComputerUseError);

    try {
      assertComputerUseModelSupported({ id: "deepseek-v4-pro", input: ["text"] });
    } catch (err) {
      expect(err.code).toBe(COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL);
    }
  });

  it("blocks models with unknown input capabilities", () => {
    expect(() => assertComputerUseModelSupported({
      id: "custom-model",
      provider: "custom",
    })).toThrow(COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL);
  });
});
