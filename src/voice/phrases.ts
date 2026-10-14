const maximumPhrase = 800
const maximumQueued = 2
const maximumBuffered = maximumPhrase * maximumQueued
const highStart = 0xd800
const highEnd = 0xdbff
const lowStart = 0xdc00
const lowEnd = 0xdfff
const prefix = (text: string) => {
  let length = Math.min(text.length, maximumPhrase)
  const end = text.charCodeAt(length - 1)
  const next = text.charCodeAt(length)
  if (end >= highStart && end <= highEnd && next >= lowStart && next <= lowEnd) length -= 1
  return text.slice(0, length)
}
const phraseLength = (buffer: string, flush: boolean) => {
  const candidate = prefix(buffer)
  const end = candidate.search(/[.!?\n]/u)
  if (end >= 0) return end + 1
  if (buffer.length >= maximumPhrase) return candidate.lastIndexOf(" ") + 1 || candidate.length
  return flush ? buffer.length : 0
}
export class Phrases {
  #cursor = 0
  #buffer = ""
  append(text: string) {
    const tail = text.slice(this.#cursor)
    if (text.length < this.#cursor || this.#buffer.length + tail.length > maximumBuffered) return false
    this.#buffer += tail
    this.#cursor = text.length
    return true
  }
  next(flush: boolean): string | undefined {
    const length = phraseLength(this.#buffer, flush)
    if (length === 0) return undefined
    const phrase = this.#buffer.slice(0, length).trim()
    this.#buffer = this.#buffer.slice(length)
    return phrase.length === 0 ? this.next(flush) : phrase
  }
  get empty() {
    return this.#buffer.length === 0
  }
}
