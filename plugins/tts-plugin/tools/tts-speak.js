export const name = "tts-speak";
export const description = "让 Agent 朗读指定文本，实时流式合成语音并通过音响播放。调用后立刻返回。";
export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "要朗读的文本" },
    voice: { type: "string", description: "音色 ID，不传则用默认音色" },
  },
  required: ["text"],
};

export async function execute(input, ctx) {
  const voice = input.voice || ctx.config.get("defaultVoice") || "zh_female_vv_uranus_bigtts";
  ctx.bus.emit({ type: "tts:start-stream", text: input.text, voice }, ctx.sessionPath);
  return { content: [{ type: "text", text: "正在朗读..." }] };
}
