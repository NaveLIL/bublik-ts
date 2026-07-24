// ═══════════════════════════════════════════════
//  Helper для random-фраз через `|`-разделитель.
//  Использование:
//    economy.cmd.heist.phrase_open: "Foo {robber}|Bar {robber}|Baz {robber}"
//    pickPhrase('economy.cmd.heist.phrase_open', locale, { robber: '...' })
// ═══════════════════════════════════════════════

import { i18n } from '../../core/I18n';

export function pickPhrase(key: string, locale: string, vars?: Record<string, any>): string {
  const raw = i18n.t(key, locale, vars);
  if (!raw || typeof raw !== 'string') return raw;
  if (!raw.includes('|')) return raw;
  const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return raw;
  return parts[Math.floor(Math.random() * parts.length)];
}
