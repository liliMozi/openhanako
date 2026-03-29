---
name: image-gen-guide
description: MUST read before calling image-gen_generate-image — contains prompt writing rules and required post-call workflow
---

# 图片生成

你可以使用 `image-gen_generate-image` 工具根据文字描述生成图片。当用户请求创建、绘制、生成图片/插画/照片时，调用此工具。

## 流程

1. 按照下方的 Prompt 编写规范，将用户请求转化为英文 prompt
2. 调用 `image-gen_generate-image`，传入 prompt 和参数
3. 工具返回图片的本地文件路径
4. **立即调用 `stage_files` 将图片呈现给用户**：`stage_files({ filepaths: ["返回的路径"] })`

必须调用 `stage_files`，否则用户看不到图片。

## 参数

- `prompt`（必填）：英文图片描述，按下方规范编写
- `filename`：保存的文件名（不含扩展名），简短有意义的英文，如 "moonlit-cat"
- `image`：参考图的文件路径或 URL（用于图生图）
- `aspect_ratio`：长宽比（"1:1"、"4:3"、"3:4"、"16:9"、"9:16"、"3:2"、"2:3"、"21:9"）
- `size`：分辨率（"2K"、"4K"）
- `format`：输出格式（"png"、"jpeg"、"webp"）
- `quality`：生成质量（"low"、"medium"、"high"）

## Prompt 编写规范

**语言**：始终使用英文编写 prompt。

**结构顺序**（图片模型对前面的词权重更高，按重要性排列）：

```
主体（who/what）→ 动作/状态 → 环境/背景 → 光线/氛围 → 画风/媒介
```

**具体化规则**：
- 用户说"猫" → 补充品种、毛色、姿态、表情（如 "a fluffy gray cat curled up on a windowsill, eyes half-closed"）
- 用户说"风景" → 补充季节、时间、天气、具体场景（如 "autumn mountain valley at golden hour, mist rising from a river"）
- 用户没说情绪 → 根据内容推断一个氛围词（serene, dramatic, cozy, melancholic...）
- 避免抽象词（"美丽的"、"好看的"），用具体视觉描述替代
- 不在 prompt 里写否定句（"没有XX"），图片模型不理解否定，改成描述你想要的内容

**长度**：50-150 个英文词，用逗号分隔概念，不写长句。

**默认画风**：当用户没有指定画风时，在 prompt 末尾附加以下描述：

```
modern Japanese illustration style, soft cel-shaded, clean linework, muted warm color palette with cream and indigo tones, elegant and serene atmosphere, anime-influenced but mature aesthetic
```

当用户明确指定了风格（如"油画风格"、"赛博朋克"、"水彩"、"写实照片"等），不附加默认画风。

**示例转换**：

用户："画一只猫"
→ prompt: "a fluffy calico cat sitting on a sunlit wooden desk, looking up with gentle curious eyes, a few scattered cherry blossom petals nearby, soft afternoon light streaming through a window, modern Japanese illustration style, soft cel-shaded, clean linework, muted warm color palette with cream and indigo tones, elegant and serene atmosphere, anime-influenced but mature aesthetic"

用户："帮我画一张赛博朋克风格的城市夜景"
→ prompt: "a sprawling cyberpunk cityscape at night, neon signs reflecting on rain-slicked streets, towering skyscrapers with holographic advertisements, flying vehicles leaving light trails, dense atmospheric fog, vibrant neon pink and electric blue lighting, cinematic wide-angle composition, detailed and immersive"
（用户指定了赛博朋克，不附加默认画风）

## 其他

- 用户发送了图片附件并要求修改/参考时，将附件路径传入 `image` 参数
- 如果生成失败，工具会返回错误信息，请告知用户具体原因
- 每次生成都要为 `filename` 起名，反映图片内容
