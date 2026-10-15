import { expect, it } from "vitest"
import { Phrases } from "../src/voice/phrases.ts"

it("stages a fast complete multilingual reply through bounded scalar-safe windows without losing its tail", () => {
  const first = `${"x".repeat(799)}😀fin. `
  const second = "Bonjour! ".repeat(180)
  const third = "Привет! ".repeat(180)
  const text = first + second + third
  const spans = [
    { language: "en", start: 0, end: first.length },
    { language: "fr", start: first.length, end: first.length + second.length },
    { language: "ru", start: first.length + second.length, end: text.length }
  ]
  const phrases = new Phrases()
  expect(phrases.append(text, spans)).toBe(true)
  const spoken: string[] = []
  const languages: string[] = []
  while (!phrases.empty) {
    const phrase = phrases.next(true)
    if (phrase === undefined) {
      expect(phrases.empty).toBe(true)
      break
    }
    expect(phrase.text.length).toBeLessThanOrEqual(800)
    expect(() => encodeURI(phrase.text)).not.toThrow()
    spoken.push(phrase.text)
    languages.push(phrase.language)
  }
  expect(spoken.join("").replaceAll(/\s/gu, "")).toBe(text.replaceAll(/\s/gu, ""))
  expect(languages).toContain("en")
  expect(languages).toContain("fr")
  expect(languages).toContain("ru")
})

it("waits for a complete phrase and accepts growing authoritative snapshots without repeating a staged window", () => {
  const phrases = new Phrases()
  expect(phrases.append("hello")).toBe(true)
  expect(phrases.next(false)).toBeUndefined()
  expect(phrases.empty).toBe(false)
  expect(phrases.append("hello world.")).toBe(true)
  expect(phrases.next(false)?.text).toBe("hello world.")
  expect(phrases.empty).toBe(true)
  expect(phrases.append("edited source")).toBe(false)
})
