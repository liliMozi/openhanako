/**
 * time-utils.js — 日界线 + 逻辑日期工具
 *
 * 系统全局以凌晨 4:00 为日界线（4:00 前算前一天）。
 * 日记、记忆编译、滚动摘要等模块共享此定义。
 */

export const DAY_BOUNDARY_HOUR = 4;

/**
 * 计算逻辑日期：4:00 前算前一天
 * @param {Date} [now]
 * @returns {{ logicalDate: string, rangeStart: Date, rangeEnd: Date }}
 */
export function getLogicalDay(now = new Date()) {
  const base = new Date(now);
  if (base.getHours() < DAY_BOUNDARY_HOUR) base.setDate(base.getDate() - 1);

  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  const logicalDate = `${yyyy}-${mm}-${dd}`;

  const rangeStart = new Date(base);
  rangeStart.setHours(DAY_BOUNDARY_HOUR, 0, 0, 0);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  return { logicalDate, rangeStart, rangeEnd };
}
