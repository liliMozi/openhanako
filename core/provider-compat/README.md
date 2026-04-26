# Provider 兼容层规范

> 本目录是 hana 唯一的 provider-specific payload 兼容层。
> 任何按 provider 走分支的代码都必须遵守本文件规则。

## 核心纪律

1. **唯一对外入口**：所有出站 payload 兼容必须经过 [`core/provider-compat.js`](../provider-compat.js) 的 `normalizeProviderPayload(payload, model, options)`。chat 路径（`engine.js` 注册的 `before_provider_request` 钩子）和 utility 路径（`llm-client.js` 的 `callText`）共享这一个入口。
2. **通用补丁留主入口**：与 provider 无关的处理（空 tools 数组剥离、不兼容 provider 的 thinking 字段剥离）写在 `provider-compat.js` 主入口。
3. **Provider-specific 补丁拆子文件**：每个 provider 一个 `core/provider-compat/<name>.js`，互不串扰。
4. **接口契约**：每个子文件 export `matches(model) → boolean`（必须容忍 `model = null/undefined`，不抛错）和 `apply(payload, model, options) → payload`（不可 mutate 输入 payload）。
5. **dispatch 单调性**：dispatcher 按数组顺序遍历，第一个 `matches` 返回 true 的子模块负责处理（first-match-wins）。一个 model 只匹配一个子模块。新 provider 默认加在数组末尾；只有当模块的 `matches` 是另一模块的子集（更具体的规则）时才前置，避免被通用规则吞掉。
6. **禁止散落**：调用点（`callText`、`engine.js` 钩子、route handler 等）禁止内联 provider-specific 补丁。一旦发现，迁移到本目录。

## 新增 provider 补丁的步骤

1. 在 `core/provider-compat/` 下新建 `<provider>.js`
2. 文件顶部 JSDoc 注释必须写明：
   - 处理的 provider（`provider` 字段值或 baseUrl 模式）
   - 解决的具体协议问题（链接到官方文档）
   - **删除条件**（即什么情况下整个文件可整块删掉）
3. export `matches(model)` 和 `apply(payload, model, options)`，签名见下文
4. 在 `core/provider-compat.js` 的 `PROVIDER_MODULES` 数组末尾加入 import
5. 在 `tests/provider-compat/<provider>.test.js` 加测试：
   - `matches` 真值表（正例 / 反例 / `model=null`）
   - `apply` 在 `mode: "chat"` 和 `mode: "utility"` 两种上下文的行为
   - 不可变性断言（apply 不 mutate 输入 payload）

## 升级 SDK 时的检查清单

升级 `@mariozechner/pi-coding-agent` 或 `@mariozechner/pi-ai` 后必须执行：

1. 跑 `npm test` 全套，重点关注 `tests/provider-compat.test.js` 和 `tests/provider-compat/*.test.js`
2. 检查每个 `provider-compat/*.js` 顶部的"删除条件"，对照 SDK 升级 changelog 看是否还需要保留
3. 如果某个 provider 子模块的删除条件已满足（SDK 升级后官方一等公民化），删除该文件并从 `PROVIDER_MODULES` 移除 import
4. 如果 SDK 改了 `message.content` 的内部表示（影响 `deepseek.js` 的 `extractReasoningFromContent`），更新 extract 逻辑

## 接口契约

### `matches(model) → boolean`

```js
/**
 * 判断本模块是否处理这个 model。
 *
 * 实现要求：
 *   - 纯函数，无副作用
 *   - 优先用 provider / baseUrl / quirks 等数据声明字段，避免按 model.id 字符串硬匹配
 *   - 必须容忍字段缺失：遇到 model = null/undefined 或目标字段不存在时返回 false，
 *     不抛错（dispatcher 不能因为某个子模块的 matches 崩溃影响其他模块）
 *   - 不可依赖 `this`：dispatcher 通过 `import * as mod` 的 namespace object 调用，
 *     namespace 是 frozen 的且无 `this` 上下文。matches 与 apply 都必须是顶层导出的独立函数
 */
export function matches(model) { ... }
```

### `apply(payload, model, options) → payload`

```js
/**
 * 对 payload 应用本 provider 的全部兼容补丁。
 *
 * 实现要求：
 *   - 不可变契约：返回新对象（或原对象，未修改时）；不直接 mutate 调用方传入的 payload
 *   - 必须能处理 mode: "chat" 和 mode: "utility" 两种调用上下文
 *   - 必须能容忍 model 字段缺失（保守处理，宁可不补也别错补）
 *   - `options` 字段是开放扩展的：dispatcher 把调用方传入的整个 options 透传给所有子模块；子模块按需读取自己关心的字段，未识别的字段必须忽略，不报错
 */
export function apply(payload, model, options) { ... }
```

## 已知子模块

| 文件 | 处理 provider | 删除条件 |
|---|---|---|
| [`deepseek.js`](deepseek.js) | DeepSeek 思考模式协议（含 reasoning_content 回传兜底） | DeepSeek 不再要求回传 reasoning_content；或 pi-ai 直接处理 reasoning_content 字段不再走 thinkingSignature 路标 |
| [`qwen.js`](qwen.js) | Dashscope Qwen `enable_thinking` quirk（utility mode 关思考） | quirks 系统重构 / dashscope 协议改成 reasoning_effort |

子模块的对外 API 仅有 `matches` 和 `apply` 两个 export。其它 export（如 `deepseek.js` 的 `extractReasoningFromContent`、`ensureReasoningContentForToolCalls`）属于实现细节、仅供同文件和单元测试访问，**不构成对外契约**。升级 SDK 想删 helper 时不需顾虑外部依赖。

## 历史背景

本架构由 commit `2a9ea17`（README 奠基）至 `0d87520`（llm-client 收口）一系列 commit 引入，根因来自 issue [#468](https://github.com/liliMozi/openhanako/issues/468) 的 DeepSeek 思考模式 400。设计 spec（本地工作文档，不入仓）：[docs/superpowers/specs/2026-04-26-provider-compat-layer-design.md](../../docs/superpowers/specs/2026-04-26-provider-compat-layer-design.md)。
