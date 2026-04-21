import React from 'react';
import { useSettingsStore } from '../store';
import { t, VALID_THEMES, autoSaveConfig } from '../helpers';
import { SelectWidget } from '../widgets/SelectWidget';
import { Toggle } from '../widgets/Toggle';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import styles from '../Settings.module.css';

const platform = window.platform;
const i18n = window.i18n;

const THEME_NAME_KEYS: Record<string, string> = {
  'warm-paper': 'settings.appearance.warmPaper',
  'midnight': 'settings.appearance.midnight',
  'high-contrast': 'settings.appearance.highContrast',
  'grass-aroma': 'settings.appearance.grassAroma',
  'contemplation': 'settings.appearance.contemplation',
  'absolutely': 'settings.appearance.absolutely',
  'delve': 'settings.appearance.delve',
  'deep-think': 'settings.appearance.deepThink',
  'claude-design': 'settings.appearance.claudeDesign',
  'auto': 'settings.appearance.auto',
};

const THEME_MODE_KEYS: Record<string, string> = {
  'warm-paper': 'settings.appearance.warmPaperMode',
  'midnight': 'settings.appearance.midnightMode',
  'high-contrast': 'settings.appearance.highContrastMode',
  'grass-aroma': 'settings.appearance.grassAromaMode',
  'contemplation': 'settings.appearance.contemplationMode',
  'absolutely': 'settings.appearance.absolutelyMode',
  'delve': 'settings.appearance.delveMode',
  'deep-think': 'settings.appearance.deepThinkMode',
  'claude-design': 'settings.appearance.claudeDesignMode',
  'auto': 'settings.appearance.autoMode',
};

export function InterfaceTab() {
  const { settingsConfig } = useSettingsStore();
  const currentTheme = localStorage.getItem('hana-theme') || 'auto';
  const serifEnabled = localStorage.getItem('hana-font-serif') !== '0';
  const paperTextureEnabled = localStorage.getItem('hana-paper-texture') === '1';
  const leavesOverlayEnabled = localStorage.getItem('hana-leaves-overlay') === '1';

  const locale = settingsConfig?.locale || 'zh-CN';
  const localeVal = ['zh-CN', 'zh-TW', 'ja', 'ko', 'en'].includes(locale) ? locale
    : locale.startsWith('zh') ? 'zh-CN'
    : locale.startsWith('ja') ? 'ja'
    : locale.startsWith('ko') ? 'ko'
    : 'en';

  // 时区
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const commonTz = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kolkata',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Pacific/Auckland', 'Australia/Sydney',
  ];
  const tzSet = new Set(commonTz);
  if (browserTz && !tzSet.has(browserTz)) commonTz.unshift(browserTz);
  const currentTz = settingsConfig?.timezone || browserTz || 'Asia/Shanghai';
  if (!tzSet.has(currentTz) && currentTz !== browserTz) commonTz.unshift(currentTz);
  const tzOptions = commonTz.map(tz => {
    try {
      const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date()).find((p: any) => p.type === 'timeZoneName')?.value || '';
      return { value: tz, label: `${tz.replace(/_/g, ' ')}  (${offset})` };
    } catch { return { value: tz, label: tz.replace(/_/g, ' ') }; }
  });

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="interface">
      <SettingsSection title={t('settings.appearance.theme')} variant="flush">
        <div className={styles['theme-options']}>
          {VALID_THEMES.map(theme => (
            <button
              key={theme}
              className={`${styles['theme-card']}${currentTheme === theme ? ' ' + styles['active'] : ''}`}
              data-theme={theme}
              onClick={() => {
                setTheme?.(theme);
                localStorage.setItem('hana-theme', theme);
                platform?.settingsChanged?.('theme-changed', { theme });
                useSettingsStore.setState({});
              }}
            >
              <div className={styles['theme-card-name']}>{t(THEME_NAME_KEYS[theme])}</div>
              <div className={styles['theme-card-mode']}>{t(THEME_MODE_KEYS[theme])}</div>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.appearance.title')}>
        <SettingsRow
          label={t('settings.appearance.serifFont')}
          hint={t('settings.appearance.serifFontHint')}
          control={
            <Toggle
              on={serifEnabled}
              onChange={(next) => {
                setSerifFont?.(next);
                platform?.settingsChanged?.('font-changed', { serif: next });
                useSettingsStore.setState({});
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.appearance.paperTexture')}
          hint={t('settings.appearance.paperTextureHint')}
          control={
            <Toggle
              on={paperTextureEnabled}
              onChange={(next) => {
                (window as any).setPaperTexture?.(next);
                platform?.settingsChanged?.('paper-texture-changed', { enabled: next });
                useSettingsStore.setState({});
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.appearance.leavesOverlay')}
          hint={t('settings.appearance.leavesOverlayHint')}
          control={
            <Toggle
              on={leavesOverlayEnabled}
              onChange={(next) => {
                localStorage.setItem('hana-leaves-overlay', next ? '1' : '0');
                window.dispatchEvent(new CustomEvent('hana-settings', {
                  detail: { type: 'leaves-overlay-changed', enabled: next },
                }));
                platform?.settingsChanged?.('leaves-overlay-changed', { enabled: next });
                useSettingsStore.setState({});
              }}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.locale.title')}>
        <SettingsRow
          label={t('settings.locale.language')}
          hint={t('settings.locale.languageHint')}
          control={
            <SelectWidget
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'ja', label: '日本語' },
                { value: 'ko', label: '한국어' },
                { value: 'en', label: 'English' },
              ]}
              value={localeVal}
              onChange={async (val) => {
                await autoSaveConfig({ locale: val }, { silent: true });
                await i18n?.load(val);
                if (i18n) i18n.defaultName = useSettingsStore.getState().agentName;
                useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
                platform?.settingsChanged?.('locale-changed', { locale: val });
                useSettingsStore.setState({});
              }}
            />
          }
        />
        <SettingsRow
          label={t('settings.locale.timezone')}
          hint={t('settings.locale.timezoneHint')}
          control={
            <SelectWidget
              options={tzOptions}
              value={currentTz}
              onChange={(val) => autoSaveConfig({ timezone: val })}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
