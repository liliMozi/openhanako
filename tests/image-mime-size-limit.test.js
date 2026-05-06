import { describe, it, expect } from "vitest";
import { MAX_CHAT_IMAGE_BASE64_CHARS, isChatImageBase64WithinLimit } from "../../shared/image-mime.js";

describe("image-mime size limits", () => {
  it("limits base64 images to 10 MB", () => {
    expect(MAX_CHAT_IMAGE_BASE64_CHARS).toBe(10 * 1024 * 1024);
  });

  it("accepts images within 10 MB", () => {
    const data = "a".repeat(10 * 1024 * 1024);
    expect(isChatImageBase64WithinLimit(data)).toBe(true);
  });

  it("rejects images exceeding 10 MB", () => {
    const data = "a".repeat(10 * 1024 * 1024 + 1);
    expect(isChatImageBase64WithinLimit(data)).toBe(false);
  });
});
