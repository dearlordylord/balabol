import { Schema } from "effect"
import { expect, it } from "vitest"
import { VoiceFrame, VoiceEvent, VoiceSnapshot } from "../src/voice/index.ts"
const sessionId = "11111111-1111-4111-8111-111111111111"
const backendIncarnationId = "33333333-3333-4333-8333-333333333333"
const utteranceId = "22222222-2222-4222-8222-222222222222"
const receipt = { deliveryId: utteranceId, text: "Final", recordId: 0, position: 0, role: "user", languageSpans: [] }
const pending = {
  backendIncarnationId,
  utteranceId,
  deliveryId: utteranceId,
  text: "Final",
  languageSpans: [],
  receipt,
  error: null
}
const snapshot = {
  backendIncarnationId,
  controlDeadlineAt: 30000,
  sessionId,
  status: "ended",
  muted: false,
  sequence: 2,
  firstSequence: 1,
  audioFramesReceived: 21,
  sampleFramesReceived: 6720,
  events: [],
  nextAfter: 2,
  output: null,
  pending: [pending]
}
it("validates canonical pending input identity and receipt payload at the snapshot edge", () => {
  expect(Schema.decodeUnknownSync(VoiceSnapshot)(snapshot)).toEqual(snapshot)
  expect(Schema.is(VoiceSnapshot)({ ...snapshot, pending: [{ ...pending, backendIncarnationId: sessionId }] })).toBe(
    false
  )
  expect(Schema.is(VoiceSnapshot)({ ...snapshot, pending: [{ ...pending, receipt: null }] })).toBe(true)
  expect(Schema.is(VoiceSnapshot)({ ...snapshot, pending: [{ ...pending, deliveryId: sessionId }] })).toBe(false)
  expect(
    Schema.is(VoiceSnapshot)({ ...snapshot, pending: [{ ...pending, receipt: { ...receipt, text: "other" } }] })
  ).toBe(false)
  expect(Schema.is(VoiceSnapshot)({ ...snapshot, pending: [pending, pending, pending] })).toBe(false)
})
it("rejects malformed frame metadata, dependent sample lengths and event identities", () => {
  expect(
    Schema.is(VoiceFrame)({ sampleRate: 16000, channels: 1, samplesPerChannel: 320, data: new Int16Array(319) })
  ).toBe(false)
  expect(
    Schema.is(VoiceFrame)({ sampleRate: 16000, channels: 1, samplesPerChannel: 320, data: new Uint8Array(320) })
  ).toBe(false)
  expect(
    Schema.is(VoiceEvent)({ kind: "Interim", sessionId, utteranceId: "invalid", sequence: 1, text: "temporary" })
  ).toBe(false)
})
