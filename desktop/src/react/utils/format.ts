/**
 * 纯工具函数，从 modules/utils.js 平移为 TS module
 */

export function toSlash(s: string): string { return s.replace(/\\/g, '/'); }
export function baseName(s: string): string { return s.replace(/\\/g, '/').split('/').pop() || s; }

const _escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, ch => _escapeMap[ch]);
}

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        row.push(field); field = '';
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        if (ch === '\r') i++;
      } else field += ch;
    }
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  return rows;
}

// 扩展名识别统一走 file-kind 中心表；禁止维护私有 IMAGE_EXTS 表。
// 保留此 helper 纯粹是 API 形式（传 name，返回 boolean），内部委托给中心表。
import { isImageOrSvgExt, extOfName } from './file-kind';

export function isImageFile(name: string): boolean {
  return isImageOrSvgExt(extOfName(name));
}

export function formatSessionDate(isoStr: string): string {
  const t = window.t ?? ((p: string) => p);
  const date = new Date(isoStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('time.justNow');
  if (diffMin < 60) return t('time.minutesAgo', { n: diffMin });
  if (diffHr < 24) return t('time.hoursAgo', { n: diffHr });
  if (diffDay < 7) return t('time.daysAgo', { n: diffDay });

  const m = date.getMonth() + 1;
  const d = date.getDate();
  return t('time.dateFormat', { m, d });
}

export function cronToHuman(schedule: number | string): string {
  const t = window.t ?? ((p: string) => p);
  if (typeof schedule === 'number') {
    const h = Math.round(schedule / 3600000);
    return h > 0 ? t('cron.everyHours', { n: h }) : t('cron.everyMinutes', { n: Math.round(schedule / 60000) });
  }
  const s = String(schedule);
  const parts = s.split(' ');
  if (parts.length !== 5) return s;
  const [min, hour, , , dow] = parts;
  if (min.startsWith('*/') && hour === '*' && dow === '*') {
    return t('cron.everyMinutes', { n: min.slice(2) });
  }
  if (min === '0' && hour.startsWith('*/') && dow === '*') {
    return t('cron.everyHours', { n: hour.slice(2) });
  }
  if (min === '0' && hour === '*' && dow === '*') return t('cron.hourly');
  if (hour === '*' && dow === '*' && /^\d+$/.test(min)) return t('cron.hourly');
  if (dow === '*' && hour !== '*' && min !== '*') {
    return t('cron.dailyAt', { hour, min: min.padStart(2, '0') });
  }
  const dayNames: string[] = (window.t as (...args: unknown[]) => unknown)('cron.dayNames') as string[] || ['日', '一', '二', '三', '四', '五', '六'];
  const weekPrefix = t('cron.weekPrefix');
  if (dow !== '*' && hour !== '*') {
    const dayStr = dow.split(',').map(d => `${weekPrefix}${(Array.isArray(dayNames) ? dayNames : [])[+d] || d}`).join('/');
    return t('cron.weeklyAt', { days: dayStr, hour, min: min.padStart(2, '0') });
  }
  return s;
}

/**
 * 从 assistant 回复中解析 mood 区块
 */
export function parseMoodFromContent(content: string): { mood: string | null; text: string } {
  if (!content) return { mood: null, text: '' };
  const moodRe = /<(mood|pulse|reflect)>([\s\S]*?)<\/(?:mood|pulse|reflect)>/;
  const match = content.match(moodRe);
  if (!match) return { mood: null, text: content };
  const raw = match[2].trim()
    .replace(/^```\w*\n?/, '').replace(/\n?```\s*$/, '')
    .replace(/^\n+/, '').replace(/\n+$/, '');
  const text = content.replace(moodRe, '').replace(/^\n+/, '').trim();
  return { mood: raw, text };
}

/**
 * 给 md-content 里的代码块注入复制按钮
 */
export function injectCopyButtons(container: HTMLElement): void {
  const t = window.t ?? ((p: string) => p);
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.querySelector('.copy-btn')) continue;
    // eslint-disable-next-line no-restricted-syntax -- copy button injected into rendered Markdown HTML, outside React tree
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = t('attach.copy');
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      const text = code ? code.textContent : pre.textContent;
      navigator.clipboard.writeText(text || '').then(() => {
        btn.textContent = t('attach.copied');
        setTimeout(() => { btn.textContent = t('attach.copy'); }, 1500);
      });
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  }
}
