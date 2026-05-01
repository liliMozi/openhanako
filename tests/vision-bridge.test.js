import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VisionBridge,
  VISUAL_PRIMITIVES_END,
  VISUAL_PRIMITIVES_START,
  VISION_CONTEXT_END,
  VISION_CONTEXT_START,
} from "../core/vision-bridge.js";

const image = { type: "image", data: "BASE64", mimeType: "image/png" };
const pathA = "/tmp/upload-a.png";
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-vision-bridge-"));
  tempDirs.push(dir);
  return dir;
}

function makeBridge(callText = vi.fn(async () => [
  "image_overview: A desk screenshot with a red error banner.",
  "user_request_answer: The screenshot shows an error state relevant to the question.",
  "evidence: red banner and visible editor layout.",
  "uncertainty: exact line number is unclear.",
].join("\n")), resolveVisionConfig = null) {
  return {
    callText,
    bridge: new VisionBridge({
      resolveVisionConfig: resolveVisionConfig || (() => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      })),
      callText,
    }),
  };
}

describe("VisionBridge", () => {
  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("analyzes text-only model images and registers notes by attachment path", async () => {
    const { bridge, callText } = makeBridge();

    const result = await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    expect(callText.mock.calls[0][0].messages[0].content[0].text).toContain("User request");
    expect(callText.mock.calls[0][0].messages[0].content[0].text).toContain("what is this?");
    expect(result.images).toBeUndefined();
    expect(result.text).toContain(`[attached_image: ${pathA}]`);

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is this?` }] },
    ], "/tmp/session.jsonl");

    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(injected.messages[0].content[0].text).toContain("user_request_answer");
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_END);
  });

  it("restores vision notes from the session sidecar after the in-memory bridge is gone", async () => {
    const dir = makeTempDir();
    const sessionPath = path.join(dir, "session.jsonl");
    const imagePath = path.join(dir, "upload-a.png");
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath,
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${imagePath}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [imagePath],
    });

    expect(callText).toHaveBeenCalledTimes(1);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "session-vision-notes.json"), "utf-8"));
    expect(sidecar.sessions["session.jsonl"].images[imagePath]).toMatchObject({
      imagePath,
      visionModel: { id: "qwen-vl", provider: "dashscope" },
      targetModel: { id: "deepseek-chat", provider: "deepseek" },
    });

    const restored = new VisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });
    const injected = restored.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${imagePath}]\nwhat is this?` }] },
    ], sessionPath);

    expect(injected.injected).toBe(1);
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(injected.messages[0].content[0].text).toContain("user_request_answer");
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_END);
  });

  it("bounds the in-memory note cache while keeping evicted notes recoverable from sidecar", async () => {
    const dir = makeTempDir();
    const firstSession = path.join(dir, "first.jsonl");
    const secondSession = path.join(dir, "second.jsonl");
    const firstImage = path.join(dir, "first.png");
    const secondImage = path.join(dir, "second.png");
    const { callText } = makeBridge();
    const bridge = new VisionBridge({
      resolveVisionConfig: () => ({
        model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
        api: "openai-completions",
        api_key: "sk-test",
        base_url: "https://example.test/v1",
      }),
      callText,
      now: (() => {
        let n = 0;
        return () => ++n;
      })(),
      maxCacheEntries: 1,
    });
    const targetModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };

    await bridge.prepare({
      sessionPath: firstSession,
      targetModel,
      text: `[attached_image: ${firstImage}]\nfirst`,
      images: [image],
      imageAttachmentPaths: [firstImage],
    });
    await bridge.prepare({
      sessionPath: secondSession,
      targetModel,
      text: `[attached_image: ${secondImage}]\nsecond`,
      images: [{ ...image, data: "BASE64-2" }],
      imageAttachmentPaths: [secondImage],
    });

    expect(bridge._noteByPath.size).toBeLessThanOrEqual(1);

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${firstImage}]\nfirst` }] },
    ], firstSession);

    expect(injected.injected).toBe(1);
    expect(injected.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(injected.messages[0].content[0].text).toContain("image_overview");
    expect(bridge._noteByPath.size).toBeLessThanOrEqual(1);
  });

  it("routes Gemini family models through their native box_2d format", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A UI screenshot with a red error banner near the top.",
      visible_text: ["Error 500"],
      objects_and_layout: "The banner sits above the main editor area.",
      charts_or_data: "none",
      user_request: "Find the error.",
      user_request_answer: "The error is in the red banner.",
      evidence: "The red banner contains the text Error 500.",
      uncertainty: "none",
      visual_primitives: [
        {
          id: "banner",
          type: "box",
          label: "red error banner",
          box_2d: [100, 200, 180, 760],
          confidence: 0.92,
        },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "gemini-3-flash-preview",
        provider: "gemini",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: false,
          coordinateSpace: "norm-1000",
          boxOrder: "yxyx",
          outputFormat: "gemini",
          groundingMode: "native",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhere is the error?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = callText.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain("visual_primitives");
    expect(prompt).toContain("box_2d");
    expect(prompt).toContain("[ymin, xmin, ymax, xmax]");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhere is the error?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain(VISUAL_PRIMITIVES_START);
    expect(text).toContain('coord="norm-1000"');
    expect(text).toMatch(/box:\s*\[200,\s*100,\s*760,\s*180\]/);
    expect(text).toContain("red error banner");
    expect(text).toContain("grounding: native");
    expect(text).toContain(VISUAL_PRIMITIVES_END);
  });

  it("routes newer Qwen visual models through the Qwen bbox_2d and point_2d family format", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A settings screen with a primary save button.",
      user_request_answer: "The save button is near the bottom right.",
      evidence: "The button is visually emphasized.",
      visual_primitives: [
        { id: "save", label: "save button", bbox_2d: [710, 820, 930, 890], confidence: 0.84 },
        { id: "toggle", label: "theme toggle", point_2d: [320, 240], confidence: 0.77 },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "qwen3.6-plus",
        provider: "dashscope",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "qwen",
          groundingMode: "native",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhere should I click to save?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = callText.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain("bbox_2d");
    expect(prompt).toContain("point_2d");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhere should I click to save?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain("box: [710, 820, 930, 890]");
    expect(text).toContain("point: [320, 240]");
    expect(text).toContain("grounding: native");
  });

  it("routes prompted computer-use style models through visual anchors", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A browser page with a search field and a submit button.",
      user_request_answer: "Use the submit button after entering the query.",
      evidence: "The button is right of the search field.",
      visual_anchors: [
        { id: "submit", label: "submit button", role: "button", center: [840, 310], confidence: 0.71 },
        { id: "search", label: "search field", role: "textbox", box: [180, 270, 760, 350], confidence: 0.74 },
      ],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "anchor",
          groundingMode: "prompted",
        },
      },
      api: "anthropic-messages",
      api_key: "sk-test",
      base_url: "https://api.anthropic.com",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat should I interact with?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = callText.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain("visual_anchors");
    expect(prompt).toContain("center");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat should I interact with?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain("point: [840, 310]");
    expect(text).toContain("box: [180, 270, 760, 350]");
    expect(text).toContain("grounding: prompted");
  });

  it("keeps a stable unavailable primitive block when structured models return no usable coordinates", async () => {
    const callText = vi.fn(async () => JSON.stringify({
      image_overview: "A document screenshot.",
      user_request_answer: "The content is visible, but no reliable target coordinate was found.",
      evidence: "Text is readable.",
      visual_primitives: [],
    }));
    const { bridge } = makeBridge(callText, () => ({
      model: {
        id: "gpt-4o",
        provider: "openai",
        input: ["text", "image"],
        visionCapabilities: {
          grounding: true,
          boxes: true,
          points: true,
          coordinateSpace: "norm-1000",
          boxOrder: "xyxy",
          outputFormat: "anchor",
          groundingMode: "prompted",
        },
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://api.openai.com/v1",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is on screen?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is on screen?` }] },
    ], "/tmp/session.jsonl");
    const text = injected.messages[0].content[0].text;
    expect(text).toContain(VISUAL_PRIMITIVES_START);
    expect(text).toContain('grounding="unavailable"');
    expect(text).toContain("reason: no valid coordinates");
  });

  it("keeps note-only routing for vision models without a coordinate contract", async () => {
    const { bridge, callText } = makeBridge(undefined, () => ({
      model: { id: "kimi-k2.6", provider: "kimi-coding", input: ["text", "image"] },
      api: "anthropic-messages",
      api_key: "sk-test",
      base_url: "https://api.kimi.com/coding/",
    }));

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const prompt = callText.mock.calls[0][0].messages[0].content[0].text;
    expect(prompt).toContain("Return a concise paper note");
    expect(prompt).not.toContain("visual_primitives");

    const injected = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nwhat is this?` }] },
    ], "/tmp/session.jsonl");
    expect(injected.messages[0].content[0].text).not.toContain(VISUAL_PRIMITIVES_START);
  });

  it("does nothing for image-capable target models", async () => {
    const { bridge, callText } = makeBridge();

    const result = await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "gpt-4o", provider: "openai", input: ["text", "image"] },
      text: "what is this?",
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    expect(callText).not.toHaveBeenCalled();
    expect(result.images).toEqual([image]);
  });

  it("fails closed when a text-only target has images but no vision model", async () => {
    const bridge = new VisionBridge({
      resolveVisionConfig: () => null,
      callText: vi.fn(),
    });

    await expect(bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "what is this?",
      images: [image],
      imageAttachmentPaths: [pathA],
    })).rejects.toThrow(/vision auxiliary model/i);
  });

  it("reuses cached analysis for the same image and same user request", async () => {
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath: "/tmp/a.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });
    await bridge.prepare({
      sessionPath: "/tmp/b.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "[attached_image: /tmp/other.png]\nwhat is this?",
      images: [image],
      imageAttachmentPaths: ["/tmp/other.png"],
    });

    expect(callText).toHaveBeenCalledTimes(1);
  });

  it("does not reuse cached analysis for a different user request on the same image", async () => {
    const { bridge, callText } = makeBridge();

    await bridge.prepare({
      sessionPath: "/tmp/a.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nhow many kittens are there?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });
    await bridge.prepare({
      sessionPath: "/tmp/b.jsonl",
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: "[attached_image: /tmp/other.png]\nwhat color is the blanket?",
      images: [image],
      imageAttachmentPaths: ["/tmp/other.png"],
    });

    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached analysis across different auxiliary vision models", async () => {
    let model = { id: "kimi-k2.6", provider: "kimi-coding", input: ["text", "image"] };
    const callText = vi.fn()
      .mockResolvedValueOnce("image_overview: note-only analysis")
      .mockResolvedValueOnce(JSON.stringify({
        image_overview: "Grounded analysis",
        user_request_answer: "The error is marked.",
        evidence: "A highlighted banner.",
        visual_primitives: [
          { id: "v1", type: "box", ref: "highlighted banner", box: [20, 30, 120, 220] },
        ],
      }));
    const { bridge } = makeBridge(callText, () => ({
      model,
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://example.test/v1",
    }));

    const payload = {
      targetModel: { id: "deepseek-chat", provider: "deepseek", input: ["text"] },
      text: `[attached_image: ${pathA}]\nwhat is this?`,
      images: [image],
      imageAttachmentPaths: [pathA],
    };

    await bridge.prepare({ ...payload, sessionPath: "/tmp/a.jsonl" });
    model = {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      input: ["text", "image"],
      visionCapabilities: {
        grounding: true,
        boxes: true,
        points: true,
        coordinateSpace: "norm-1000",
        boxOrder: "xyxy",
      },
    };
    await bridge.prepare({ ...payload, sessionPath: "/tmp/b.jsonl" });

    expect(callText).toHaveBeenCalledTimes(2);
  });

  it("injects notes into only the user message that carries an attached image marker", async () => {
    const { bridge } = makeBridge();
    const targetModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel,
      text: `[attached_image: ${pathA}]\nfirst question`,
      images: [image],
      imageAttachmentPaths: [pathA],
    });

    const result = bridge.injectNotes([
      { role: "user", content: [{ type: "text", text: `[attached_image: ${pathA}]\nfirst question` }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "follow-up" }] },
    ], "/tmp/session.jsonl");

    expect(result.injected).toBe(1);
    expect(result.messages[0].content[0].text).toContain(VISION_CONTEXT_START);
    expect(result.messages[2].content[0].text).toBe("follow-up");
  });
});
