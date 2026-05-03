export const name = "tts-get-voices";
export const description = "查询可用的 TTS 音色列表。";
export const parameters = {
  type: "object",
  properties: {},
};

const VOICES = [
  { id: "zh_female_vv_uranus_bigtts", name: "Vivi 2.0", lang: "zh", desc: "通用女声" },
  { id: "saturn_zh_female_cancan_tob", name: "知性灿灿", lang: "zh", desc: "角色扮演" },
  { id: "saturn_zh_female_keainvsheng_tob", name: "可爱女生", lang: "zh", desc: "角色扮演" },
  { id: "zh_female_xiaohe_uranus_bigtts", name: "小何", lang: "zh", desc: "通用女声" },
  { id: "en_male_tim_uranus_bigtts", name: "Tim", lang: "en", desc: "英文男声" },
];

export async function execute() {
  const text = VOICES.map(v => `- ${v.id}: ${v.name}（${v.desc}）`).join("\n");
  return { content: [{ type: "text", text: `可用音色：\n${text}` }] };
}
