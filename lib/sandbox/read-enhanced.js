/**
 * read-enhanced.js — 增强的 readFile，支持 xlsx/docx 解析和非 UTF-8 编码检测
 *
 * PI SDK 的 read tool 只做 buffer.toString("utf-8")，对 xlsx/docx 等二进制格式
 * 和 GBK 编码的 CSV 会乱码。这个模块包装 readFile 操作：
 *   - .xlsx/.xls → 用 ExcelJS 解析为纯文本表格
 *   - .docx → 用 mammoth 提取纯文本
 *   - 文本文件 → 检测编码，非 UTF-8 自动转换
 */

import { readFile as fsReadFile } from "fs/promises";
import { extname } from "path";

// ── xlsx → 纯文本 ──

async function xlsxToText(filePath) {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parts = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount === 0) continue;
    parts.push(`[Sheet: ${sheet.name}]`);

    // 收集所有行的文本
    const rows = [];
    sheet.eachRow((row) => {
      const cells = [];
      for (let i = 1; i <= sheet.columnCount; i++) {
        cells.push(String(row.getCell(i).text).replace(/\t/g, " "));
      }
      rows.push(cells);
    });

    // 计算每列最大宽度（上限 40 字符），对齐输出
    const colWidths = [];
    for (let c = 0; c < (rows[0]?.length || 0); c++) {
      let max = 0;
      for (const row of rows) {
        const len = (row[c] || "").length;
        if (len > max) max = len;
      }
      colWidths.push(Math.min(max, 40));
    }

    for (const cells of rows) {
      const line = cells
        .map((cell, i) => {
          const w = colWidths[i] || 0;
          return cell.length > w ? cell.slice(0, w - 1) + "…" : cell.padEnd(w);
        })
        .join(" | ");
      parts.push(line);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ── docx → 纯文本 ──

async function docxToText(filePath) {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// ── 编码检测 ──

/**
 * 检查 buffer 是否是合法的 UTF-8。
 * 非法 UTF-8 序列会被 TextDecoder 替换为 U+FFFD，统计替换数判断。
 */
function isValidUtf8(buffer) {
  // 有 UTF-8 BOM 直接认定
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return true;

  // 快速扫描：纯 ASCII 不需要进一步检测
  let hasHighByte = false;
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    if (buffer[i] > 0x7F) { hasHighByte = true; break; }
  }
  if (!hasHighByte) return true;

  // 用 TextDecoder fatal 模式验证
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function decodeBuffer(buffer) {
  if (isValidUtf8(buffer)) {
    // 去掉 UTF-8 BOM
    if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
      return buffer.subarray(3).toString("utf-8");
    }
    return buffer.toString("utf-8");
  }
  // 非 UTF-8，尝试 GBK（中文 Windows 最常见）
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    // fallback
    return buffer.toString("utf-8");
  }
}

// ── 导出 ──

const XLSX_EXTS = new Set([".xlsx"]); // ExcelJS 不支持旧版 .xls 二进制格式
const DOCX_EXTS = new Set([".docx"]); // mammoth 只支持 .docx (Office Open XML)，不支持旧版 .doc
const TEXT_LIKE_EXTS = new Set([
  ".csv", ".tsv", ".txt", ".log", ".md", ".json", ".xml", ".html", ".htm",
  ".yaml", ".yml", ".ini", ".cfg", ".conf", ".properties",
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".cs",
  ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".sql",
]);

/**
 * 创建增强的 readFile 函数，作为 PI SDK read tool 的 operations.readFile
 * @returns {(absolutePath: string) => Promise<Buffer>}
 */
export function createEnhancedReadFile() {
  return async (absolutePath) => {
    const ext = extname(absolutePath).toLowerCase();

    // xlsx/xls → 解析为纯文本，返回 UTF-8 buffer
    if (XLSX_EXTS.has(ext)) {
      try {
        const text = await xlsxToText(absolutePath);
        return Buffer.from(text, "utf-8");
      } catch (err) {
        // 解析失败，返回错误提示而非乱码
        const { t } = await import("../../server/i18n.js");
        return Buffer.from(`[${t("error.xlsxParseFailed", { ext, msg: err.message })}]`, "utf-8");
      }
    }

    // docx → 提取纯文本，返回 UTF-8 buffer
    if (DOCX_EXTS.has(ext)) {
      try {
        const text = await docxToText(absolutePath);
        return Buffer.from(text, "utf-8");
      } catch (err) {
        const { t } = await import("../../server/i18n.js");
        return Buffer.from(`[${t("error.docxParseFailed", { ext, msg: err.message })}]`, "utf-8");
      }
    }

    // 读取原始 buffer
    const buffer = await fsReadFile(absolutePath);

    // 文本文件：检测编码，非 UTF-8 转换
    if (TEXT_LIKE_EXTS.has(ext) || !ext) {
      const decoded = decodeBuffer(buffer);
      return Buffer.from(decoded, "utf-8");
    }

    // 其他文件：原样返回（图片等由 PI SDK 自己处理）
    return buffer;
  };
}
