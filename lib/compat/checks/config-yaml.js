/**
 * config-yaml.js — config.yaml 可解析性检查
 *
 * 尝试读取并解析 config.yaml。
 * 如果解析失败（YAML 语法错误），备份原文件并从模板重建。
 */

import fs from "fs";
import path from "path";
import { t } from "../../../server/i18n.js";

export function checkConfigYaml({ agentDir, hanakoHome }) {
  const configPath = path.join(agentDir, "config.yaml");
  if (!fs.existsSync(configPath)) return;

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    // 简单检测：YAML 至少应该有 agent: 或 api: 这样的顶级 key
    // 不做完整 YAML 解析（避免引入额外依赖），只检查非空且有基本结构
    if (!content.trim()) throw new Error(t("error.compatConfigEmpty"));
    if (!content.includes(":")) throw new Error(t("error.compatConfigInvalid"));
  } catch (err) {
    const backupPath = configPath + `.bak-${Date.now()}`;
    try {
      fs.renameSync(configPath, backupPath);
    } catch {}

    // 尝试从产品目录复制模板
    const templateCandidates = [
      path.join(path.dirname(path.dirname(agentDir)), "..", "lib", "config.example.yaml"),
    ];
    for (const tpl of templateCandidates) {
      try {
        if (fs.existsSync(tpl)) {
          fs.copyFileSync(tpl, configPath);
          return { fixed: true, message: t("error.compatConfigCorrupted", { msg: err.message }) };
        }
      } catch {}
    }

    return { fixed: true, message: t("error.compatConfigBackedUp", { msg: err.message, backup: path.basename(backupPath) }) };
  }
}
