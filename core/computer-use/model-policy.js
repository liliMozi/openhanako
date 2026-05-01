import { COMPUTER_USE_ERRORS, computerUseError } from "./errors.js";

export function modelSupportsComputerUse(model) {
  return Array.isArray(model?.input) && model.input.includes("image");
}

export function assertComputerUseModelSupported(model) {
  if (modelSupportsComputerUse(model)) return;
  throw computerUseError(
    COMPUTER_USE_ERRORS.REQUIRES_VISION_MODEL,
    "Computer Use requires a model with image input support.",
    {
      modelId: model?.id || null,
      provider: model?.provider || null,
      input: Array.isArray(model?.input) ? model.input : null,
    },
  );
}
