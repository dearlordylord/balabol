# Balabol

**Purpose:** Describe the repository and its current development state.
**Status:** Durable conversation with opt-in subscription Sol/Luna, local whisper.cpp recognition and Apple speech synthesis; physical-device qualification remains separate.
**Authority:** Product requirements live in the published prototype issue; engineering guidance lives in AGENTS.md.
**Expected use:** Start here before contributing.
**Lifecycle:** Update when the product spec, setup or implementation status changes.

An iOS-first personal voice assistant with one enduring conversation. SwiftUI/MVVM client, TypeScript/Effect backend, @firfi/unii memory. Speech providers default to deterministic fakes; recognition can opt into pinned local whisper.cpp and synthesis into installed Apple voices. Answers and summaries default to fakes, with independent opt-ins for the qualified ChatGPT subscription models.

- [Accepted prototype specification](https://github.com/dearlordylord/balabol/issues/1) — ready-for-agent
- [Synchronized local specification](docs/product/prototype-spec.md)
- [Domain glossary](GLOSSARY.md)
- [Wayfinder map](.scratch/voice-prototype/map.md)
- [Engineering standards](docs/engineering/standards.md)
- [Deferred real-model qualification](.scratch/followups/issues/01-create-real-model-check-task.md)

## Run the text prototype on Simulator

The backend is a Terminal process; the interface is a separate native iOS app. Opening the backend URL in a browser shows setup instructions, not a chat.

1. Use Node 24 and the pinned pnpm. On first setup, install gitleaks and run `pnpm install --strict-peer-dependencies` as described below.
2. In Terminal at this repository, run `pnpm build`, then `pnpm start`. Keep that process running; it listens at `http://127.0.0.1:8787` by default.
3. Open `ios/Balabol.xcodeproj` in Xcode. Select the `Balabol` scheme and an iOS 17+ Simulator, then press Run.
4. Simulator opens the conversation automatically using `http://127.0.0.1:8787` on first launch. No URL entry or Connect tap is required. A previously saved server remains selected; use **Server** only to change it.
5. Enter text in **Message** and tap **Send**. Relaunch the app to verify the single saved transcript remains. Replies are deterministic fake output; the voice launcher below enables microphone input with scripted recognition.

For a physical iPhone, choose your local signing team in Xcode and use the private HTTPS endpoint from the voice launcher below.

## Start the voice prototype

Use Node 24, the pinned pnpm, a running Docker Desktop, and Tailscale signed in as the owner on both Mac and iPhone. Enable HTTPS certificates in the Tailscale admin DNS settings once. Then run:

```sh
pnpm dev:voice
```

The launcher builds the backend, starts the pinned self-hosted LiveKit container, generates temporary private credentials, and configures private Tailscale Serve routes. Keep its Terminal open. It uses the enduring `.data/conversation.sqlite`; override `BALABOL_DATABASE` only when intentionally selecting another local database. It adds no fixture messages, recordings, models or speech engines.

Simulator uses `http://127.0.0.1:8787`. The launcher prints the iPhone control URL at HTTPS port 8444 and supplies the separate WSS media URL at port 8443 through scoped session joins. On a new ordinary iPhone installation, select **Server** once and paste that control URL; device provisioning can supply it automatically for an explicit debug test launch. No LiveKit keys or media endpoint need entering in the app.

Tap **Start voice**, allow microphone access, speak and pause, then check the accepted transcript. Recognition defaults to explicitly scripted fake output. Enable local recognition below to interpret supplied microphone utterances. Silent and empty results create no message. **Mute** stops new input; **End voice** releases the temporary room while accepted conversation input remains saved. Interim text is tentative; a final remains visibly pending until the durable receipt arrives.

`pnpm dev:voice --check` checks prerequisites without starting services or changing Serve configuration. Startup refuses occupied backend/media/Serve ports and missing HTTPS setup; it never stops another process or replaces existing Serve port 9999. Ctrl-C stops only this launch's backend, container and unchanged owned routes, and deletes its temporary credentials. The saved conversation is retained.

LiveKit ICE advertises the Mac's Tailscale IPv4 address on UDP 7882 with TCP 7881 fallback. Those Docker media ports bind host interfaces so the tailnet can reach them; LiveKit requires scoped join tokens. HTTPS signaling alone does not qualify media reachability, locked-screen behavior or physical iPhone audio. Those require the corresponding device checks.

## Use all real providers

With local resources provisioned and the ChatGPT subscription connected, run:

```sh
pnpm dev:voice --real
```

This selects subscription Sol replies, subscription Luna summaries, local whisper.cpp recognition and installed Apple synthesis. Explicit provider environment overrides still apply. The launcher builds the native speech helper and backend before starting private services; it does not download weights or install voices. `pnpm dev:voice --real --check` remains read-only. Default `pnpm dev:voice` retains deterministic fixtures.

Apple synthesis requires macOS and Xcode Command Line Tools. `pnpm build:speech` builds the Swift 6 helper outside the checkout at `~/.local/share/balabol/tools/apple-speech/apple-speech`. `BALABOL_APPLE_SPEECH_EXECUTABLE` and `BALABOL_FFMPEG_EXECUTABLE` override its executable and ffmpeg paths. `BALABOL_SYNTHESIS_PROVIDER=apple` selects synthesis independently. Startup enumerates actual installed voices and rejects missing configured languages. Apple voice locale is separate from detected input language and requested response language; no extra detector guesses language inside a phrase.

Each complete phrase has at most 800 UTF-16 units and 60 seconds of audio. AVSpeechSynthesizer writes a protected temporary file, then ffmpeg converts complete audio to mono PCM16LE at 24 kHz. Validated chunks contain at most 1,200 frames; completion requires native end-of-stream and delegate completion, not truncation. Phrase generation precedes the first chunk, so this adapter is replaceable rather than a claim of incremental native streaming. Cancellation stops the owned process, fences late audio and removes temporary files. Speech failure retains useful conversation text and allows a subsequent reply.

Voice owns the overall response/playback deadline: fixtures default to 30 seconds, local synthesis to five minutes, covering prior-memory wait, inference and playback. `BALABOL_VOICE_COMPLETION_MILLIS` explicitly overrides it up to five minutes. Control keepalive remains independent. Physical iPhone media, locked-screen and interruption checks remain [issue #29](https://github.com/dearlordylord/balabol/issues/29).

## Enable local recognition

The initial local recognition adapter uses whisper.cpp **1.9.5** and multilingual **small** weights. Setup never downloads or installs them. Provision them explicitly using the reviewed bounded runbook in [issue #27](https://github.com/dearlordylord/balabol/issues/27). The default executable is `/opt/homebrew/bin/whisper-cli`; the model is `~/.local/share/balabol/models/whisper/ggml-small.bin`. Startup requires exactly 487,601,967 bytes and SHA-256 `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`, from `ggerganov/whisper.cpp` at revision `5359861c739e955e79d9a303bcbc70fb988958b1`.

```sh
BALABOL_RECOGNITION_PROVIDER=whisper pnpm dev:voice
```

`BALABOL_WHISPER_EXECUTABLE` and `BALABOL_WHISPER_MODEL` override the local paths, retaining the exact version and weight checks. Unset the provider or use `fake` for deterministic fixtures. Missing or mismatched resources fail startup; there is no fake fallback. Recognition remains independent of the answer, summary and synthesis selections.

Each completed mono PCM16LE 16 kHz utterance (at most 15 seconds) gets one serialized native process. The 30-second deadline includes queueing, model initialization and inference; cancellation terminates and reaps that process and removes private temporary audio. The next utterance starts a fresh process after failure; a failed utterance is never retried automatically. This has a per-utterance model-load cost and does not retain a warm resident model. Native diagnostics and transcripts are not logged.

Automatic language detection preserves mixed transcript text and emits nullable whole-result `detectedLanguage` with empty exact spans. Empty text has no detected language and creates no message. Russian, French and English are the initial scope; Japanese is a future configured capability, not a quality claim. Advertised support is separate from measured language accuracy and latency; qualification evidence belongs in issue #27.

## Connect the ChatGPT subscription

`pnpm subscription` builds and opens a separate setup page on this Mac. Choose **Continue with ChatGPT** and authorize Balabol with the existing account. This does not reuse or modify the Codex login. The listener binds only to `127.0.0.1`, defaults to port 8788 and is not exposed through iPhone/Tailscale routes. `BALABOL_SUBSCRIPTION_PORT` overrides that local port; `BALABOL_SUBSCRIPTION_DIRECTORY` selects the private credential directory (default `~/.local/share/balabol/subscription`, outside the checkout).

Credentials stay in a private local directory with owner-only files and atomic replacement. The setup process holds an exclusive writer lease; stop it before starting another process that uses the same subscription directory. **Disconnect Balabol** attempts bounded remote revocation and removes the locally saved tokens. If remote revocation cannot be confirmed, the page says so and points to ChatGPT access settings. The app registration is retained for reconnecting the same account. The separate change-account flow clears that registration while retaining the host identity; only one account is active.

Connecting an account does not prove model entitlement or select real providers automatically. The exact `gpt-6.1-sol` and `gpt-6-luna` models have passed the separate subscription qualification task. No API-key fallback is configured.

## Enable real answers

Connect the subscription first, then stop the setup process so the backend can acquire its credential-writer lease. Start the text backend with:

```sh
pnpm build
BALABOL_ANSWER_PROVIDER=subscription pnpm start
```

The same environment setting applies to `pnpm dev:voice`. Subscription mode defaults to the qualified exact `gpt-6.1-sol`; `BALABOL_ANSWER_MODEL`, if provided, must match it. Unset `BALABOL_ANSWER_PROVIDER` (or set `fake`) to keep deterministic fake replies without acquiring subscription credentials. Summaries remain fake unless enabled independently below; speech providers remain independently configurable.

Real requests contain only the explicit prior unii memory, current input and requested response language, with no tools or inherited agent context. Text deltas carry no guessed language spans. Each request has a 60-second total deadline, 100,000 UTF-16 output limit, 64 KiB SSE-frame limit and 2 MiB body limit. Only a valid completed terminal succeeds; incomplete, failed, authentication and quota outcomes remain recoverable errors. Interruption cancels the request and releases its reader without disconnecting the subscription or canceling independent memory work. There is no automatic retry or model/API-key fallback. Keep paid credit fallback disabled in the connected account.

## Enable real memory summaries

Use `BALABOL_SUMMARY_PROVIDER=subscription` to select the qualified exact `gpt-6-luna` independently of the answer provider. `BALABOL_SUMMARY_MODEL`, if supplied, must match. For both real providers:

```sh
BALABOL_ANSWER_PROVIDER=subscription BALABOL_SUMMARY_PROVIDER=subscription pnpm start
```

Bootstrap shares one credential writer and inference service between both providers. unii remains the only memory authority; it receives complete summaries through Balabol's Effect adapter. Streamed partials, failures and interrupted output never become summaries. Trusted journal record kinds retain interrupted-assistant attribution through recursive compression; quoted role markers in user text cannot create that provenance.

Accepted input does not wait for summaries. A reply waits for prior memory, with a 60-second default polling budget in real-summary mode (fake mode retains two seconds). Readiness or failure ends the wait early. Timeout, failure or reply cancellation retains accepted input; late summary readiness does not restart a failed reply. Use the existing explicit **Retry** action, which reuses accepted input. Stopping a reply does not cancel independent summary work.

The summary adapter makes one inference request per invocation and has no retry or fallback. unii retains its existing maximum of five attempts to refine a completed oversized or rejected summary to its 512-byte node budget. Real provider failures, including authentication and quota, stop that job after the first failing call; explicit retry can retry failed memory jobs. Fake-provider retry behavior remains unchanged. Host shutdown cancels outstanding work; restart rebuilds from durable memory rather than committing a late completion.

## Repository tooling

Use Node >=22.19 and <25 (Node 24 is supported) and the pinned pnpm. Install gitleaks separately (macOS: brew install gitleaks), then run `pnpm install --strict-peer-dependencies` to activate Husky.

Run pnpm check:repository for formatting and staged-secret checks; pnpm secrets:files scans the working tree and pnpm secrets:history scans Git history. Pre-commit scans staged content before formatting. Pre-push scans history. Missing gitleaks fails the hooks.

Run `pnpm check-all` for the complete quality gate and `pnpm test:harness` for isolated positive/negative tooling self-checks. The [quality harness](docs/engineering/quality-harness.md) documents the pinned cohort and numeric limits; the [ownership map](docs/engineering/ownership.md) owns initial dependency boundaries. Product compiler/test/CRAP gates become active as source is added; absent product source is explicitly pending, not passing product acceptance. Speech engines and model weights are not installed by repository setup.

## Local text backend

Run `pnpm build`, then `node dist/bootstrap/main.js`. Startup parses `BALABOL_HOST` (default `127.0.0.1`), `BALABOL_PORT` (default `8787`) and `BALABOL_DATABASE` (default `.data/conversation.sqlite`). Voice startup requires loopback binding. `BALABOL_VOICE_LANGUAGES` is a comma-separated list of allowed BCP47 language tags (default `ru,fr,en`); startup validates every tag against the selected recognition, reply and synthesis providers. The fake-provider Japanese extension probe uses `ru,fr,en,ja`. Canonical language tags permit future installed languages; they do not imply provider support or real recognition quality. Use `pnpm dev:voice` for iPhone access through the owner-checked `/tailnet` proxy; session controls additionally require a private session capability. The loopback text endpoint is local development access.

`POST /conversation/messages` accepts `{deliveryId: UUID, text: string}` and returns `{deliveryId, text, recordId, position}` only after durable acceptance. Keep the same identity and original payload after uncertain delivery. Conflicting reuse returns `409 DeliveryConflict`; invalid input returns `400 InvalidInput`; unavailable memory returns `503 StorageUnavailable`. A post-raw memory failure can make the first outcome uncertain while retry returns the already durable receipt. The next admitted send automatically reconstructs the failed unii session from durable state while retaining exclusive writer ownership; no backend restart is required. Persistent storage failure returns a typed error after one recovery attempt per send. Later sends retry recovery after storage becomes available.

`GET /conversation/messages?limit=100` starts history. Continue with `after=<position>` (exclusive); positions start at zero. Responses contain `messages` and `nextAfter`, null when fewer than the requested limit remain. A full final page may require one empty follow-up read. Delivery positions identify whole messages; unii can split a message into several raw records, and `recordId` identifies its first record. Text is nonempty and limited to 100,000 UTF-16 code units; history pages contain at most 100 messages.

SQLite commits raw batches and their delivery receipt together, uses WAL/FULL with macOS fullfsync, and holds a scoped OS-released exclusive writer lease. Keep the database and companion `.writer` file on the same local durable filesystem; canonical symlink paths share the lease. Hard-link database aliases and shared network filesystems are unsupported. Acknowledgement does not promise ready summaries. Transcript reads are bounded SQL queries; the current unii contract still hydrates the complete memory journal at startup.

## iOS text client

Open `ios/Balabol.xcodeproj`, select the `Balabol` scheme, and run on an iOS 17+ simulator or device. For a device, select your local signing team in Xcode and use the HTTPS control URL printed by `pnpm dev:voice`. Simulator connects automatically to `http://127.0.0.1:8787` on first launch; a saved custom server takes precedence.

Send text, reload the app and backend, and verify it remains in the single transcript. Stop the backend before sending to exercise an uncertain result: the draft remains, and retry uses the same identity when the backend returns. A definite invalid/conflicting request preserves editable text; uncertain outcomes preserve the exact pending payload. Server changes are blocked while a delivery remains unresolved.

Run `swift test --package-path ios --scratch-path /tmp/balabol-swift-build` for Swift intent/projection tests. Keep Swift package checkouts outside this repository so default secret scanning checks application source rather than downloaded SDK test credentials. With a temporary backend running, set `BALABOL_TEST_SERVER`, `BALABOL_TEST_REPLY_SERVER` and `BALABOL_TEST_VOICE_SERVER` to its control origin to exercise the production HTTP adapters. These opt-in tests write fixture messages; use an isolated database rather than personal conversation data. Simulator checks do not qualify physical iPhone or background audio behavior.
