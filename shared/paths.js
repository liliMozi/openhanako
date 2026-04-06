/**
 * 跨平台路径等价（含符号链接解析），用于会话文件与 bridge 索引比对
 */
import fs from "fs";
import path from "path";

export function pathsEquivalent(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra === rb) return true;
  try {
    return fs.realpathSync(ra) === fs.realpathSync(rb);
  } catch {
    return false;
  }
}
