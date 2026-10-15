import type { LanguageSpan, LanguageTag } from "../language/index.ts"

// Whole-input detection is a preference, never fabricated character attribution.
// Legacy inputs select by annotation coverage; text characters never infer language.
export const selectResponseLanguage = (
  spans: readonly LanguageSpan[],
  detectedLanguage?: LanguageTag | null,
  supported: readonly string[] = []
): LanguageTag => {
  if (detectedLanguage != null && supported.includes(detectedLanguage)) return detectedLanguage
  return selectAnnotatedLanguage(spans)
}

const selectAnnotatedLanguage = (spans: readonly LanguageSpan[]): LanguageTag => {
  const coverage = new Map<string, { length: number; last: number }>()
  for (const span of spans)
    coverage.set(span.language, {
      length: (coverage.get(span.language)?.length ?? 0) + span.end - span.start,
      last: span.end
    })
  const ranked = [...coverage.entries()].sort((a, b) => b[1].length - a[1].length || b[1].last - a[1].last)
  return ranked[0]?.[0] ?? "en"
}
