import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { UiLanguage } from '@dalang/shared';
import { api } from '../lib/api.js';
import { en, type TranslationKey } from './en.js';
import { id } from './id.js';

export type { TranslationKey };

const STORAGE_KEY = 'dalang.language';
const DICTS: Record<UiLanguage, Record<TranslationKey, string>> = { en, id };

export function detectBrowserLanguage(): UiLanguage {
  if (typeof navigator === 'undefined') return 'en';
  const lang = navigator.language || navigator.languages?.[0] || 'en';
  return /^id\b/i.test(lang) ? 'id' : 'en';
}

function readStoredLanguage(): UiLanguage | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'en' || raw === 'id') return raw;
  } catch {
    // ignore
  }
  return null;
}

function writeStoredLanguage(lang: UiLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

interface I18nContextValue {
  lang: UiLanguage;
  setLang: (next: UiLanguage) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  /** Label for an API enum value (status, kind, role, complexity, severity); unknown values pass through. */
  te: (value: string) => string;
  formatTime: (iso: string) => string;
  formatDateTime: (iso: string) => string;
  formatNumber: (n: number) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  serverLanguage,
  onLanguageChanged,
  children,
}: {
  serverLanguage?: UiLanguage | null;
  onLanguageChanged?: (lang: UiLanguage) => void;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<UiLanguage>(() => {
    return readStoredLanguage() ?? detectBrowserLanguage();
  });
  const pendingLangRef = useRef<UiLanguage | null>(null);

  // Sync from server setting when first fetched (server is authoritative across reloads),
  // without letting a stale in-flight refetch overwrite an explicit user switch.
  useEffect(() => {
    if (serverLanguage !== 'en' && serverLanguage !== 'id') return;
    if (pendingLangRef.current && pendingLangRef.current !== serverLanguage) return;
    if (pendingLangRef.current === serverLanguage) {
      pendingLangRef.current = null;
    }
    setLangState(serverLanguage);
    writeStoredLanguage(serverLanguage);
  }, [serverLanguage]);

  useEffect(() => {
    document.documentElement.lang = lang;
    writeStoredLanguage(lang);
  }, [lang]);

  const setLang = (next: UiLanguage) => {
    pendingLangRef.current = next;
    setLangState(next);
    writeStoredLanguage(next);
    void api
      .updateSettings({ language: next })
      .then(() => {
        if (pendingLangRef.current === next) pendingLangRef.current = null;
        onLanguageChanged?.(next);
      })
      .catch(() => {
        if (pendingLangRef.current === next) pendingLangRef.current = null;
      });
  };

  const value = useMemo<I18nContextValue>(() => {
    const locale = lang === 'id' ? 'id-ID' : 'en-US';
    const dict = DICTS[lang];
    return {
      lang,
      setLang,
      t: (key, vars) => {
        let text: string = dict[key] ?? en[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            text = text.replaceAll(`{${k}}`, String(v));
          }
        }
        return text;
      },
      te: (value) => {
        const key = `enum.${value}` as TranslationKey;
        return dict[key] ?? en[key] ?? value;
      },
      formatTime: (iso) => {
        try {
          return new Intl.DateTimeFormat(locale, {
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(iso));
        } catch {
          return iso;
        }
      },
      formatDateTime: (iso) => {
        try {
          return new Intl.DateTimeFormat(locale, {
            dateStyle: 'short',
            timeStyle: 'short',
          }).format(new Date(iso));
        } catch {
          return iso;
        }
      },
      formatNumber: (n) => new Intl.NumberFormat(locale).format(n),
    };
  }, [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
