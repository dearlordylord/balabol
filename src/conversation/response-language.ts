import type { LanguageSpan, LanguageTag } from "../language/index.ts"

// Annotation coverage selects the reply preference; text characters never infer language.
export const selectResponseLanguage = (spans: readonly LanguageSpan[]): LanguageTag => {
  const coverage = new Map<string, { length: number; last: number }>()
  for (const span of spans)
    coverage.set(span.language, {
      length: (coverage.get(span.language)?.length ?? 0) + span.end - span.start,
      last: span.end
    })
  const ranked = [...coverage.entries()].sort((a, b) => b[1].length - a[1].length || b[1].last - a[1].last)
  return ranked[0]?.[0] ?? "en"
}
