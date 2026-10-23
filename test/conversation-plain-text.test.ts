import { expect, it } from "vitest"
import type { AnswerEvent } from "../src/answer-generation/index.ts"
import { normalizeAnswerEvent, initialPlainText, type PlainTextState } from "../src/conversation/plain-text.ts"

const collect = (parts: readonly string[]) => {
  let state = initialPlainText
  const events: AnswerEvent[] = []
  for (const text of parts) {
    const result = normalizeAnswerEvent(state, { kind: "Delta", text, languageSpans: [] })
    state = result.state
    events.push(...result.events)
  }
  events.push(...normalizeAnswerEvent(state, { kind: "Completed" }).events)
  return events.flatMap((event) => (event.kind === "Delta" ? [event.text] : [])).join("")
}
const examples = [
  ["Approximately ~5 °C; ~ is a literal operator.", "Approximately ~5 °C; ~ is a literal operator."],
  [
    "### Bonjour 日本語 😀\nHello **world** and *amis*.\n- One\n2. Deux\n",
    "Bonjour 日本語 😀\nHello world and amis.\nOne\nDeux\n"
  ],
  ["Plain **strong** / __fort__ and ~~gone~~!", "Plain strong / fort and gone!"],
  [
    "Inline `a*b + snake_case` and [label](https://example.com/a(b)).",
    "Inline a*b + snake_case and label (https://example.com/a(b))."
  ],
  ["![photo](https://example.com/image)", "photo (https://example.com/image)"],
  ["```ts\n# literal\nconst value = '**code**';\n```\nAfter", "# literal\nconst value = '**code**';\nAfter"],
  ["~~~\n```not closing\n~~literal~~\n~~~\nFin", "```not closing\n~~literal~~\nFin"],
  ["Before **hello\nworld** after.", "Before hello\nworld after."],
  ["**hello\nworld**", "hello\nworld"],
  [
    "snake_case _literal_identifier and a*b*c = 2*3*4; C# C++ >= 5 >5 #hashtag",
    "snake_case _literal_identifier and a*b*c = 2*3*4; C# C++ >= 5 >5 #hashtag"
  ],
  ["\\*literal\\* and unmatched * or [bracket]", "*literal* and unmatched * or [bracket]"],
  ["Prefix *one**", "Prefix *one**"],
  ["# Heading #\n# Use C#\n", "Heading \nUse C#\n"],
  ["```\n😀 # literal\n```", "😀 # literal\n"],
  ["2026 is a year.\n-5 degrees.\n> A quote\n", "2026 is a year.\n-5 degrees.\nA quote\n"]
] as const
for (const [source, expected] of examples)
  it(`normalizes every split of ${JSON.stringify(source.slice(0, 26))} coherently`, () => {
    expect(collect([source])).toBe(expected)
    for (let split = 1; split < source.length; split++)
      expect(collect([source.slice(0, split), source.slice(split)]), `split ${split}`).toBe(expected)
    expect(collect(Array.from({ length: source.length }, (_, index) => source.slice(index, index + 1)))).toBe(expected)
  })
it("streams unformatted text without waiting for completion or newline", () => {
  for (const text of ["Hello plain speech", "2026 is here", "-5 degrees", ">= 5", "snake_case", "a*b*c"]) {
    const result = normalizeAnswerEvent(initialPlainText, { kind: "Delta", text, languageSpans: [] })
    expect(result.events).toEqual([{ kind: "Delta", text, languageSpans: [] }])
  }
})
it("maps exact source languages across removed syntax and leaves inserted link separation unannotated", () => {
  const text = "**français** [日本語](url)"
  const result = normalizeAnswerEvent(initialPlainText, {
    kind: "Delta",
    text,
    languageSpans: [
      { language: "fr", start: 0, end: 12 },
      { language: "ja", start: 13, end: 18 }
    ]
  })
  const completion = normalizeAnswerEvent(result.state, { kind: "Completed" })
  const deltas = [...result.events, ...completion.events].filter((event) => event.kind === "Delta")
  expect(deltas.map((event) => event.text).join("")).toBe("français 日本語 (url)")
  expect(deltas.flatMap((event) => event.languageSpans)).toEqual([
    { language: "fr", start: 0, end: 8 },
    { language: "ja", start: 9, end: 12 }
  ])
})
it("retains a raw source limit even when every received marker is removed", () => {
  let state: PlainTextState = initialPlainText
  const source = "```\n```\n".repeat(12500)
  state = normalizeAnswerEvent(state, { kind: "Delta", text: source, languageSpans: [] }).state
  expect(state.sourceCharacters).toBe(100000)
  expect(() => normalizeAnswerEvent(state, { kind: "Delta", text: "x", languageSpans: [] })).toThrow(
    "Provider output exceeds"
  )
})
it("bounds ambiguous pending annotations, coalescing adjacent identical languages", () => {
  let state: PlainTextState = initialPlainText
  state = normalizeAnswerEvent(state, { kind: "Delta", text: "[", languageSpans: [] }).state
  for (let index = 0; index < 1000; index++)
    state = normalizeAnswerEvent(state, {
      kind: "Delta",
      text: "a",
      languageSpans: [{ language: index % 2 === 0 ? "fr" : "ja", start: 0, end: 1 }]
    }).state
  expect(state.spans).toHaveLength(1000)
  expect(() =>
    normalizeAnswerEvent(state, { kind: "Delta", text: "a", languageSpans: [{ language: "fr", start: 0, end: 1 }] })
  ).toThrow("Provider annotations exceed")
})

it("coalesces adjacent pending language observations without changing their coverage", () => {
  let state: PlainTextState = initialPlainText
  state = normalizeAnswerEvent(state, { kind: "Delta", text: "[", languageSpans: [] }).state
  for (let index = 0; index < 1001; index++)
    state = normalizeAnswerEvent(state, {
      kind: "Delta",
      text: "a",
      languageSpans: [{ language: "fr", start: 0, end: 1 }]
    }).state
  expect(state.spans).toEqual([{ language: "fr", start: 1, end: 1002 }])
})

it("remaps retained multilingual annotations exactly across every provider delta split", () => {
  const source = "**français** [日本語](url)"
  const sourceSpans = [
    { language: "fr", start: 0, end: 12 },
    { language: "ja", start: 13, end: 18 }
  ]
  const partitions = Array.from({ length: source.length - 1 }, (_, index) => [
    source.slice(0, index + 1),
    source.slice(index + 1)
  ])
  partitions.push(Array.from(source))
  for (const parts of partitions) {
    let state = initialPlainText
    let offset = 0
    const events: AnswerEvent[] = []
    for (const text of parts) {
      const languageSpans = sourceSpans
        .filter((span) => span.start < offset + text.length && span.end > offset)
        .map((span) => ({
          language: span.language,
          start: Math.max(span.start, offset) - offset,
          end: Math.min(span.end, offset + text.length) - offset
        }))
      const result = normalizeAnswerEvent(state, { kind: "Delta", text, languageSpans })
      state = result.state
      offset += text.length
      events.push(...result.events)
    }
    events.push(...normalizeAnswerEvent(state, { kind: "Completed" }).events)
    let text = ""
    const spans: { language: string; start: number; end: number }[] = []
    for (const event of events) {
      if (event.kind !== "Delta") continue
      spans.push(
        ...event.languageSpans.map((span) => ({
          ...span,
          start: span.start + text.length,
          end: span.end + text.length
        }))
      )
      text += event.text
    }
    expect(text).toBe("français 日本語 (url)")
    expect(spans).toEqual([
      { language: "fr", start: 0, end: 8 },
      { language: "ja", start: 9, end: 12 }
    ])
  }
})
