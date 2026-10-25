import { Deferred, Effect, Layer, Redacted } from "effect"
import { expect, it } from "vitest"
import { Conversation } from "../src/conversation/index.ts"
import { sonioxRecognitionLayer, type SonioxSocketFactory } from "../src/speech-recognition/index.ts"
import { Voice, SpeechActivity, fakeSpeechActivityLayer } from "../src/voice/index.ts"
import { startVoiceRequest } from "./voice-admission-fixture.ts"
import { classifiedVoiceInput, waitForOutput, withVoiceOutput } from "./voice-output-fixture.ts"
import { SonioxSocket } from "./soniox-fixture.ts"

it("uploads Soniox audio while speech is still active without admitting a premature turn", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const socket = new SonioxSocket([{ tokens: [{ text: "Bonjour", language: "fr", is_final: true }] }])
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
        for (let poll = 0; socket.sent.length < 2 && poll < 40; poll++) yield* Effect.sleep(5)
        expect(socket.sent.some((message) => message instanceof Uint8Array)).toBe(true)
        expect(socket.sent).not.toContain("")
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
        let page = yield* conversation.page({ limit: 100 })
        for (let poll = 0; page.messages.length === 0 && poll < 200; poll++) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
          "Bonjour"
        ])
        expect(socket.sent.filter((message) => message === "")).toHaveLength(1)
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})

it("mute seals live audio and preserves recognition and reply delivery", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const socket = new SonioxSocket([{ tokens: [{ text: "Captured", language: "en", is_final: true }] }])
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
        yield* voice.mute(join.sessionId, true)
        const output = (yield* waitForOutput(voice, join.sessionId, "AwaitingReady")).output
        if (output?.manifest == null) throw new Error("Missing publication")
        expect((yield* voice.snapshot(join.sessionId, 0)).muted).toBe(true)
        yield* voice.ready(join.sessionId, {
          responseId: output.responseId,
          outputEpoch: output.outputEpoch,
          trackSid: output.manifest.trackSid
        })
        yield* waitForOutput(voice, join.sessionId, "Delivered")
        expect(socket.sent.filter((message) => message === "")).toHaveLength(1)
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})

it("End cancels a live socket and late provider text cannot become saved input", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const socket = new SonioxSocket([], "wait")
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
        for (let poll = 0; socket.sent.length < 2 && poll < 40; poll++) yield* Effect.sleep(5)
        expect(socket.sent.some((message) => message instanceof Uint8Array)).toBe(true)
        const late = socket.onmessage
        expect(late).not.toBeNull()
        yield* voice.end(join.sessionId)
        late?.call(
          socket,
          new MessageEvent("message", {
            data: JSON.stringify({ tokens: [{ text: "Late", is_final: true }], finished: true })
          })
        )
        expect(socket.closed).toBe(true)
        expect(socket.sent).not.toContain("")
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})

it("fails a stalled live upload explicitly without accepting a partial turn", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const socket = new SonioxSocket([], "connecting")
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 125; frame++) yield* input.send(transport, transport.audio(1200))
        let snapshot = yield* voice.snapshot(join.sessionId, 0)
        for (let poll = 0; !snapshot.events.some((event) => event.kind === "Error") && poll < 100; poll++) {
          yield* Effect.sleep(5)
          snapshot = yield* voice.snapshot(join.sessionId, 0)
        }
        expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: "Error", code: "RecognitionFailed" }))
        expect(snapshot.status).toBe("active")
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        expect(socket.closed).toBe(true)
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})

it("rolls live chunks and resumes pending speech without admitting incomplete prefixes", async () => {
  const input = await Effect.runPromise(classifiedVoiceInput())
  const sockets = [
    new SonioxSocket([{ tokens: [{ text: "One", language: "en", is_final: true }] }]),
    new SonioxSocket([], "wait"),
    new SonioxSocket([{ tokens: [{ text: "Three", language: "en", is_final: true }] }])
  ]
  let opened = 0
  const factory: SonioxSocketFactory = (url, protocols) => {
    const socket = sockets[opened++]
    if (socket === undefined) throw new Error("Unexpected extra recognition")
    return socket.factory(url, protocols)
  }
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 550; frame++) yield* input.send(transport, transport.audio(1200))
        expect(opened).toBe(2)
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
        for (let frame = 0; frame < 50; frame++) yield* input.send(transport, transport.audio(0))
        sockets[1]?.message({ tokens: [{ text: "Two", language: "en", is_final: true }], finished: true })
        let page = yield* conversation.page({ limit: 100 })
        for (let poll = 0; page.messages.length === 0 && poll < 200; poll++) {
          yield* Effect.sleep(5)
          page = yield* conversation.page({ limit: 100 })
        }
        expect(page.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
          "One Two Three"
        ])
        expect(opened).toBe(3)
        expect(sockets.every((socket) => socket.closed)).toBe(true)
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, factory),
    undefined,
    undefined,
    input.layer
  )
})

it("capture gaps close an open provider socket and fence its late transcript", async () => {
  let hold = false
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const activity = Layer.effect(
    SpeechActivity,
    Effect.gen(function* () {
      const provider = yield* SpeechActivity
      return SpeechActivity.of({
        open: () =>
          provider
            .open()
            .pipe(
              Effect.map((stream) => ({
                reset: () => stream.reset(),
                push: (frame) =>
                  Effect.suspend(() =>
                    hold
                      ? Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(release)),
                          Effect.andThen(stream.push(frame))
                        )
                      : stream.push(frame)
                  )
              }))
            )
      })
    })
  ).pipe(Layer.provide(fakeSpeechActivityLayer))
  const input = await Effect.runPromise(classifiedVoiceInput(activity))
  const socket = new SonioxSocket([], "wait")
  await withVoiceOutput(
    (transport) =>
      Effect.gen(function* () {
        const voice = yield* Voice
        const conversation = yield* Conversation
        const join = yield* voice.start(startVoiceRequest())
        for (let frame = 0; frame < 10; frame++) yield* input.send(transport, transport.audio(1200))
        for (let poll = 0; socket.sent.length < 2 && poll < 40; poll++) yield* Effect.sleep(5)
        expect(socket.sent.some((message) => message instanceof Uint8Array)).toBe(true)
        const late = socket.onmessage
        expect(late).not.toBeNull()
        hold = true
        yield* transport.send(transport.audio(1200))
        yield* Deferred.await(entered)
        for (let frame = 0; frame < 20; frame++) yield* transport.send(transport.audio(1200))
        hold = false
        yield* Deferred.succeed(release, undefined)
        let snapshot = yield* voice.snapshot(join.sessionId, 0)
        for (let poll = 0; !socket.closed && poll < 100; poll++) {
          yield* Effect.sleep(5)
          snapshot = yield* voice.snapshot(join.sessionId, 0)
        }
        expect(snapshot.events).toContainEqual(expect.objectContaining({ kind: "Error", code: "CaptureDiscontinuity" }))
        expect(socket.closed).toBe(true)
        expect(socket.sent).not.toContain("")
        late?.call(
          socket,
          new MessageEvent("message", {
            data: JSON.stringify({ tokens: [{ text: "Lost prefix", is_final: true }], finished: true })
          })
        )
        expect((yield* conversation.page({ limit: 100 })).messages).toEqual([])
        yield* voice.end(join.sessionId)
      }),
    undefined,
    undefined,
    sonioxRecognitionLayer({ provider: "soniox", apiKey: Redacted.make("fixture-only") }, socket.factory),
    undefined,
    undefined,
    input.layer
  )
})
