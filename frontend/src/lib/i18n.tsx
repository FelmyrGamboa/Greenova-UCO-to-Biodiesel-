/**
 * Website language: English or Filipino (Tagalog). Settings → Language.
 *
 * Write every piece of text in English through t(): t("Start purification"), or with values
 * t("Add {grams} g Magnesol", { grams: 4.6 }). The English text is the key; the Filipino text is
 * in src/lib/fil.ts. A text without a translation shows in English, so nothing ever goes blank.
 * Messages from the backend (tiles, alarms, fault reasons) go through t() too: fil.ts has patterns
 * for the ones that contain numbers.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { FIL, FIL_PATTERNS } from "./fil";

export type Language = "en" | "fil";
export type TFunction = (text: string, values?: Record<string, string | number>) => string;

const STORAGE_KEY = "gv_language";

function readSavedLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "fil" ? "fil" : "en";
  } catch {
    return "en";
  }
}

function fill(text: string, values?: Record<string, string | number>): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

export function translate(language: Language, text: string, values?: Record<string, string | number>): string {
  if (language === "fil" && text) {
    const exact = FIL[text];
    if (exact !== undefined) return fill(exact, values);
    for (const [pattern, replacement] of FIL_PATTERNS) {
      const match = text.match(pattern);
      // each $1, $2... is translated too, so a reason inside a message also shows in Filipino
      if (match) return fill(replacement.replace(/\$(\d)/g, (_, n: string) => translate(language, match[Number(n)] ?? "")), values);
    }
  }
  return fill(text, values);
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: TFunction;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: "en",
  setLanguage: () => {},
  t: (text, values) => fill(text, values),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readSavedLanguage);

  function setLanguage(next: Language) {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable: the language still applies until the page is reloaded
    }
  }

  useEffect(() => {
    document.documentElement.lang = language === "fil" ? "fil" : "en";
  }, [language]);

  const t: TFunction = (text, values) => translate(language, text, values);
  return <LanguageContext.Provider value={{ language, setLanguage, t }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}

/** The translate function for the current language. */
export function useT(): TFunction {
  return useContext(LanguageContext).t;
}
