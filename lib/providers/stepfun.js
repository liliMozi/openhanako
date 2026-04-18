/**
 * StepFun (阶跃星辰) provider plugin
 *
 * 文档：https://platform.stepfun.com/docs
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const stepfunPlugin = {
  id: "stepfun",
  displayName: "阶跃星辰 (StepFun)",
  authType: "api-key",
  defaultBaseUrl: "https://api.stepfun.com/v1",
  defaultApi: "openai-completions",
};
