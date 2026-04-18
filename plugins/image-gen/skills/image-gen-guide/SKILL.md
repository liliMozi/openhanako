---
name: image-gen-guide
description: 使用图片/视频生成工具时必读。包含工具参数、非阻塞工作流、任务路由。
---

# 媒体生成工具指南

## 非阻塞工作流

生成是异步的。提交后工具立即返回一张卡片，你**不需要等待结果**，也**不需要调用 stage_files**。

1. 调用工具，传入 prompt 和参数
2. **告诉用户正在生成，完成后会自动显示在卡片中**
3. **继续对话**，不要等待
4. 收到 `<hana-background-result>` 通知时，自然地告知用户结果

## 工具参数

### image-gen_generate-image

- `prompt`（必填）：图片描述，中英文均可
- `count`：并发生成张数（1-4），用户说"多来几张"/"再抽几张"时用
- `image`：参考图路径（图生图、图片编辑、风格迁移时传入）
- `ratio`：长宽比（1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9）
- `resolution`：分辨率（2k, 4k）
- `quality`：画质（low, medium, high）
- `provider`：指定 provider（可选，默认自动选择）

### image-gen_generate-video

- `prompt`（必填）：视频描述，中英文均可
- `image`：参考图路径（图生视频）
- `duration`：时长（秒）
- `ratio`：长宽比
- `provider`：指定 provider（可选）

## 任务路由

| 用户意图 | 示例 | 工具 | 备注 |
|---------|------|------|------|
| 凭空生成图片 | "画一只猫" | generate-image | prompt 描述画面 |
| 编辑/修改图片 | "把帽子去掉" | generate-image + image 参数 | prompt 写编辑指令 |
| 参考图生新图 | "参考这个风格画一套icon" | generate-image + image 参数 | prompt 说明参考什么 + 要生成什么 |
| 生成视频 | "做一个猫的短视频" | generate-video | prompt 描述画面和运动 |
| 图片变视频 | "让这张图动起来" | generate-video + image 参数 | prompt 描述运动和变化 |
| 不是生成请求 | "这张图画的是什么" | 不调用 | 只是看图/聊天 |

## 注意

- 生成消耗 provider 额度，大批量前建议提醒用户
- 不同 provider 支持的参数不同，工具会自动处理
- 视频生成通常比图片慢（几十秒到几分钟），但同样不阻塞
- 图中需要出现文字时，把文字内容放在**双引号**里
