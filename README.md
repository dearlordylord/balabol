# Balabol

**Purpose:** Describe the repository and its current development state.
**Status:** Durable conversation with opt-in subscription Sol/Luna, Soniox recognition and speech synthesis; physical-device qualification remains separate.
**Authority:** Product requirements live in the published prototype issue; engineering guidance lives in AGENTS.md.
**Expected use:** Start here before contributing.
**Lifecycle:** Update when the product spec, setup or implementation status changes.

An iOS-first personal voice assistant with one enduring conversation. SwiftUI/MVVM client, TypeScript/Effect backend, @firfi/unii memory. Speech providers default to deterministic fakes; real recognition and synthesis use Soniox. Answers and summaries default to fakes, with independent opt-ins for the qualified ChatGPT subscription models.

- [Accepted prototype specification](https://github.com/dearlordylord/balabol/issues/1) — ready-for-agent
- [Synchronized local specification](docs/product/prototype-spec.md)
- [Domain glossary](GLOSSARY.md)
- [Personal knowledge architecture](docs/adr/0001-personal-knowledge-module.md)
- [Yielded agent runtime](docs/adr/0002-yielded-agent-runtime.md)
- [Personal knowledge specification — implemented](https://github.com/dearlordylord/balabol/issues/40)
- [Wayfinder map](.scratch/voice-prototype/map.md)
- [Functional conversation lifecycle specification](docs/product/functional-conversation-spec.md) — implemented through #52–#58; start changes from the [owner protocol](docs/engineering/conversation-lifecycle.md)
- [Client lifecycle verification specification](https://github.com/dearlordylord/balabol/issues/59) — event admission contracts and Quint-to-Swift conformance, implemented incrementally through #60–#63
- [Engineering standards](docs/engineering/standards.md)
- [Deferred real-model qualification](.scratch/followups/issues/01-create-real-model-check-task.md)

## Usage

Open **Usage** in the iPhone conversation toolbar for separate chat, memory-summary, recognition and synthesis counters. Chat and memory show provider-reported subscription input/output/cache tokens collected from this installation onward, not additional dollar charges. The private SQLite usage ledger in the conversation database survives backend restarts; missing observations remain unavailable and partial totals are labeled. Interrupted requests are counted without retrying them.

Speech shows actual API cost, tokens and audio duration for the configured Soniox project over the trailing 30-day UTC window, obtained from [Soniox usage summary](https://soniox.com/docs/guides/usage-summary). These project totals can include traffic outside Balabol. Refresh failures retain prior values only within the same credential scope. No billing credential is sent to the iPhone.

## Plain-text answers

The answer prompt requests plain spoken text. Conversation also removes supported residual Markdown before publishing new answer text, so live chat, saved replies, memory and speech use the same text. The incremental boundary handles headings, list/quote prefixes, matched emphasis, inline code, fenced-code wrappers and inline links. Code contents and meaningful literal symbols are retained; links keep both their label and destination.

Ordinary text streams immediately. Ambiguous formatting suffixes wait for enough input to interpret them; unmatched literals are retained on successful completion. Cancellation or provider failure discards pending, unpublished text rather than emitting it late. Existing saved history is not rewritten.

## Local operation audit

The backend exports sanitized Effect spans to `~/.local/share/balabol/diagnostics/operations.jsonl` (private permissions; rotation retains the current and previous file, up to 4 MiB each). No telemetry server is required. Spans record operation, parent/trace identity, hashed response identity, duration, outcome and typed failure reason; conversation text, credentials, raw exceptions and audio are excluded. Queue overflow and write failures are counted and reported to stderr. Shutdown drains pending writes for up to three seconds; this is operational diagnostics, not a crash-durable transaction log.

Agent runs and individual tools retain structured failure categories, safe rejection codes, budget limits and bounded execution counts, including tool errors the model later recovers from. Subscription calls and background memory summaries retain provider failure classification; summaries have independent hashed job/attempt correlation. Admission, recognition, recovered persistence and media cleanup record failures before recovery discards their operational cause. Correlation hashes use 32 hexadecimal characters across backend and client. High-frequency successful frame/poll/pump spans are excluded so they cannot crowd out diagnostic evidence.

`OperationAudit.health` exposes pending, dropped, write-failure, projection-failure and fallback-reporter-failure counts. Audit failures do not fail product work. The voice launcher drains backend stderr, forwards only bounded allowlisted audit/bootstrap health messages and reports exit code/signal; arbitrary process output remains suppressed. See the [diagnostic boundary rules](docs/engineering/standards.md#operation-diagnostics) before instrumenting another operation.

Delivery failures retain their original cause in the saved assistant receipt and display as failures after refresh or restart. A genuine interruption remains a separate result. Pre-delivery generation failures keep their existing retry semantics and are recorded in the audit.

Debug iPhone builds also retain the last 128 reply-observation diagnostics in the app cache at `balabol-reply-observation.json`: hashed input identity, stage, failure category and URLSession error code, without text, URLs or raw errors. A lost reply stream enters read-only recovery with delays from one to five seconds, retains displayed text and reads the same accepted input before resuming observation. Recovery never resends input or retries model generation. Invalid protocol data remains an explicit failure. The companion `balabol-conversation-viewport.json` records at most 128 coalesced geometry snapshots (up to four writes per second): message count, reply length, viewport size, visible-row count and bottom offset. It contains no message content or identities and helps distinguish transcript state from scroll/layout failures. The shared HTTP resource budget is six minutes so it cannot truncate the five-minute voice delivery lifetime at thirty seconds.

## Run the text prototype on Simulator

The backend is a Terminal process; the interface is a separate native iOS app. Opening the backend URL in a browser shows setup instructions, not a chat.

Backend builds and checks require Bend **2.0.36** and `timeout` or `gtimeout`, in addition to Node 24 and the pinned pnpm. The [proof/build boundary](docs/engineering/conversation-lifecycle.md#qualified-compilation-boundary) explains the required native tools and generated artifacts; builds install nothing automatically.

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

Tap **Start voice**, allow microphone access, speak and pause, then check the accepted transcript. Recognition defaults to explicitly scripted fake output. Enable local recognition below to interpret supplied microphone utterances. Silent and empty results create no message. A recognition error for one phrase shows “Couldn’t recognize that. Please repeat.” while the same session stays listening or muted; the next successful final clears the notice. **Mute** stops new input; **End voice** releases the temporary room while accepted conversation input remains saved. Interim text is tentative; a final remains visibly pending until the durable receipt arrives.

A transient backend disconnect automatically reconnects voice with bounded backoff, including when the old session cannot be sealed while the host is offline. Reconnection preserves mute intent and resolves old-session closure before opening fresh capture. It never resends accepted input or replays an interrupted answer. Platform audio interruptions still require **Resume**, and **End voice** cancels reconnection.

The native SDK microphone lifetime follows explicit unmuted voice intent independently of each transport room. Permission is required before acquisition, and initial capture waits for preparation to settle. Transient reconnects retain it; Mute, End voice, platform pause, fatal failure and shutdown release it even without a backend connection. The bridge uses LiveKit's managed recording APIs with the same software audio processing settings. Persistent initialization alone is insufficient in the pinned native SDK; actual running input must be re-established after Room cleanup. It does not buffer, transcribe or replay speech while offline. If disabling fails, the app retains the release obligation and reports that it could not confirm the microphone stopped; End retries cleanup, and a server switch keeps the current owner until release is confirmed. Physical locked-screen recovery remains device-qualified behavior, not a guarantee established by reducer tests alone.

Microphone queue pressure is a recoverable input discontinuity: the bounded ingress discards obsolete frames and resets incomplete speech without closing the session or interrupting assistant playback. Already finalized speech and accepted inputs retain their own obligations. Only a genuinely discarded unfinished utterance shows “I missed part of that. Please repeat.”; a gap with no unfinished utterance stays silent. New speech clears that notice. Diagnostics retain queue pressure and recovery timing without audio or text.

`pnpm dev:voice --check` checks prerequisites without starting services or changing Serve configuration. Startup refuses occupied backend/media/Serve ports and missing HTTPS setup; it never stops another process or replaces existing Serve port 9999. Ctrl-C stops only this launch's backend, container and unchanged owned routes, and deletes its temporary credentials. The saved conversation is retained.

During a voice session, a soft rising tone marks generation start; a short falling tone marks complete answer text before speech playback. Each sounds at most once for a fresh response. Fast responses may skip the second tone, and expired cues are skipped rather than delayed over speech. User speech, cancellation and incoming assistant audio stop the tone; the microphone remains available. A retry shows “Trying again…” and emits one short neutral tone for a newly observed retry. A live terminal answer failure emits a distinct two-pulse tone and leaves an actionable inline error; cancellation does not sound like failure. Repeated snapshots and restored history do not replay these cues. Microphone mute preserves retry and output behavior. Cue rendering uses LiveKit's existing echo-processing path. Loudspeaker audibility and echo behavior require device qualification.

LiveKit ICE advertises the Mac's Tailscale IPv4 address on UDP 7882 with TCP 7881 fallback. Those Docker media ports bind host interfaces so the tailnet can reach them; LiveKit requires scoped join tokens. HTTPS signaling alone does not qualify media reachability, locked-screen behavior or physical iPhone audio. Those require the corresponding device checks.

## Use all real providers

With Silero VAD provisioned, the ChatGPT subscription connected and a server-side `SONIOX_API_KEY` configured, run:

```sh
pnpm dev:voice --real
```

This selects subscription Sol replies, subscription Luna summaries, Soniox recognition and Soniox synthesis. Explicit supported provider overrides still apply. The launcher builds the backend before starting private services; it does not install speech engines or download weights. `pnpm dev:voice --real --check` remains read-only. Ordinary startup defaults to deterministic fixtures when no explicit provider configuration is supplied.

Soniox is the only supported real speech provider. Apple synthesis and local Qwen recognition have been removed; selecting `apple` or `qwen3-asr` fails configuration validation rather than falling back. Previously downloaded local models/runtimes outside the checkout are not removed automatically. Historical qualification records remain in the tracker and research documents.

Voice owns the overall response/playback deadline: fixtures default to 30 seconds and Soniox synthesis to five minutes, covering prior-memory wait, inference and playback. `BALABOL_VOICE_COMPLETION_MILLIS` explicitly overrides it up to five minutes. Control keepalive remains independent. Physical iPhone media, locked-screen and interruption checks remain [issue #29](https://github.com/dearlordylord/balabol/issues/29).

## Prepare speech activity detection

Run `pnpm prepare:vad` once before building the iPhone app or using real voice. It provisions the pinned Silero **v6.2.3** ONNX artifact outside the checkout at `~/.local/share/balabol/models/vad/silero-v6.2.3.onnx`. `pnpm prepare:vad --check` verifies it without downloads. Size is 2,327,524 bytes; SHA-256 is `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`. The source revision and complete artifact contract live in `src/voice/activity-model.json`, which is also bundled with the iOS model. The build verifies and copies this model into the app; weights are never committed.

`--real` selects `BALABOL_ACTIVITY_PROVIDER=silero`. Direct Soniox recognition configuration also defaults to Silero. `BALABOL_VAD_MODEL` overrides the external model path while retaining exact checks. Missing/invalid resources fail explicitly; no energy-only fallback is used. The explicit `fake` provider is for deterministic development Layers. The pinned runtime is ONNX Runtime **1.24.2** on Node and iOS. Native inference runs outside the realtime audio callback with bounded buffering and stale-result fencing. Effect owns the backend's isolated inference process, including deadlines, termination and reaping; a failed frame is not retried, and a later request can acquire a replacement worker. Neither classifier receives conversation context or tools.

## Voice turn handling and diagnostics

Debug iPhone builds and `pnpm dev:voice --real` retain bounded local technical journals for interruption, recognition and playback attribution. The iPhone journal also records foreground/background and protected-data lock transitions. These journals contain hashed correlation IDs, timing, state and error codes, without microphone recordings, transcript text or credentials. Backend metadata lives outside the checkout at `~/.local/share/balabol/diagnostics/backend.json`; the iPhone journal lives in its app cache. `BALABOL_VOICE_DIAGNOSTICS=0` opts out; release iPhone builds keep diagnostics disabled.

Real voice mode uses pinned Silero VAD before microphone onset can interrupt an answer or form a recognition segment. Both iPhone and backend use the same ONNX artifact and CPU runtime version, with private recurrent state per microphone lifetime. Classification uses 512-sample windows at 16 kHz; sustained onset takes two speech windows (64 ms), turn endpointing waits about one second of classified non-speech, and utterances remain bounded. Native barge-in rearm is independent of turn endpointing. VAD distinguishes speech from non-speech; it does not prove that residual synthesized speech is not echo. Physical far-end-only and genuine double-talk checks remain required in #29.

Voice separates recognition chunks from a completed spoken turn. The ten-second audio-buffer boundary starts another bounded recognition chunk without sending a message or starting a reply. Ordered chunk text and language spans are assembled provisionally until about one second of classified quiet and completion of every required chunk; speech that resumes before this handoff continues the same provisional turn. Once handed to durable admission, resumed speech fences the exact pending reply's audio and interrupts that response when acceptance completes. Two recognition requests may be active; a turn is bounded to 30 chunks (at most five minutes of PCM, less with partial chunks), 100,000 UTF-16 text units and 1,000 language spans. Exceeding capacity or losing any required chunk rejects the incomplete turn with a recoverable notice and suppresses its remaining speech until quiet; it never accepts a surviving prefix or suffix as a complete message. Genuine interruption of an already active reply is unchanged.

Recognition preserves mixed transcript text with validated token-derived UTF-16 language spans. Whole-result `detectedLanguage` is nullable when no single language describes the result. Empty text has no detected language and creates no message. Russian, French and English are the initial scope; Japanese is also configurable; configured support is not a quality claim. Advertised support is separate from measured language accuracy and latency; qualification evidence belongs in issue #27.

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

Real answer runs receive explicit prior unii memory, current input, requested response language and the application’s scoped knowledge/dictionary tools. Later model steps include only that run’s tool results and committed provider context; they do not inherit an unrelated agent session. Text deltas carry no guessed language spans. Each request has a 60-second total deadline, 100,000 UTF-16 output limit, 64 KiB SSE-frame limit and 2 MiB body limit. Only a valid completed terminal succeeds; incomplete, failed, authentication and quota outcomes remain recoverable errors. Interruption cancels the request and releases its reader without disconnecting the subscription or canceling independent memory work. Temporary answer-inference failures retry the same model request at most twice, after one and three seconds, within the existing total request deadline. Once a request has released model output, it is not replayed. Completed agent steps and tools are never rerun by this recovery. Authentication, quota, invalid requests/protocol and application limits fail without automatic retry; independent memory-summary retry behavior is unchanged. There is no model/API-key fallback. Keep paid credit fallback disabled in the connected account.

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

Use `pnpm test` (or `pnpm test:fast`) for fast tests and fresh CRAP evidence. Expensive `*.slow.test.ts` checks run only through the explicit `pnpm test:slow` command; pre-commit and `check-all` exclude them.

Run `pnpm check-all` for the complete routine quality gate and `pnpm test:harness` for isolated positive/negative tooling self-checks. The [quality harness](docs/engineering/quality-harness.md) documents the pinned cohort and numeric limits; the [ownership map](docs/engineering/ownership.md) owns initial dependency boundaries. Product compiler/test/CRAP gates become active as source is added; absent product source is explicitly pending, not passing product acceptance. Speech engines and model weights are not installed by repository setup.

## Local text backend

Run `pnpm build`, then `node dist/bootstrap/main.js`. Startup parses `BALABOL_HOST` (default `127.0.0.1`), `BALABOL_PORT` (default `8787`) and `BALABOL_DATABASE` (default `.data/conversation.sqlite`). Voice startup requires loopback binding. `BALABOL_VOICE_LANGUAGES` is a comma-separated list of allowed BCP47 language tags (default `ru,fr,en`); startup validates every tag against the selected recognition, reply and synthesis providers. The fake-provider Japanese extension probe uses `ru,fr,en,ja`. Canonical language tags permit future installed languages; they do not imply provider support or real recognition quality. Use `pnpm dev:voice` for iPhone access through the owner-checked `/tailnet` proxy; session controls additionally require a private session capability. The loopback text endpoint is local development access.

`POST /conversation/messages` accepts `{deliveryId: UUID, text: string}` and returns `{deliveryId, text, recordId, position}` only after durable acceptance. Keep the same identity and original payload after uncertain delivery. Conflicting reuse returns `409 DeliveryConflict`; invalid input returns `400 InvalidInput`; unavailable memory returns `503 StorageUnavailable`. A post-raw memory failure can make the first outcome uncertain while retry returns the already durable receipt. The next admitted send automatically reconstructs the failed unii session from durable state while retaining exclusive writer ownership; no backend restart is required. Persistent storage failure returns a typed error after one recovery attempt per send. Later sends retry recovery after storage becomes available.

`GET /conversation/messages?limit=100` starts history. Continue with `after=<position>` (exclusive); positions start at zero. Responses contain `messages` and `nextAfter`, null when fewer than the requested limit remain. A full final page may require one empty follow-up read. Delivery positions identify whole messages; unii can split a message into several raw records, and `recordId` identifies its first record. Text is nonempty and limited to 100,000 UTF-16 code units; history pages contain at most 100 messages.

SQLite commits raw batches and their delivery receipt together, uses WAL/FULL with macOS fullfsync, and holds a scoped OS-released exclusive writer lease. Keep the database and companion `.writer` file on the same local durable filesystem; canonical symlink paths share the lease. Hard-link database aliases and shared network filesystems are unsupported. Acknowledgement does not promise ready summaries. Transcript reads are bounded SQL queries; the current unii contract still hydrates the complete memory journal at startup.

## iOS text client

Open `ios/Balabol.xcodeproj`, select the `Balabol` scheme, and run on an iOS 17+ simulator or device. For a device, select your local signing team in Xcode and use the HTTPS control URL printed by `pnpm dev:voice`. Simulator connects automatically to `http://127.0.0.1:8787` on first launch; a saved custom server takes precedence.

Send text, reload the app and backend, and verify it remains in the single transcript. Stop the backend before sending to exercise an uncertain result: the draft remains, and retry uses the same identity when the backend returns. A definite invalid/conflicting request preserves editable text; uncertain outcomes preserve the exact pending payload. Server changes are blocked while a delivery remains unresolved.

Run `swift test --package-path ios --scratch-path /tmp/balabol-swift-build` for Swift intent/projection tests. Keep Swift package checkouts outside this repository so default secret scanning checks application source rather than downloaded SDK test credentials. With a temporary backend running, set `BALABOL_TEST_SERVER`, `BALABOL_TEST_REPLY_SERVER` and `BALABOL_TEST_VOICE_SERVER` to its control origin to exercise the production HTTP adapters. These opt-in tests write fixture messages; use an isolated database rather than personal conversation data. Simulator checks do not qualify physical iPhone or background audio behavior.

## Local Wiktionary tool

The answer agent can call `lookup_dictionary` with a language and word (including known inflected forms). Lookup uses exact, case-sensitive NFC-normalized spelling; it does not perform fuzzy matching. It returns bounded senses, etymology, pronunciations, forms, translations and related words with English definitions and source attribution. Before creating etymologies or vocabulary associations, the agent must call the dictionary even without an explicit user request. Unavailable or missing evidence cannot support a claim of attested ancestry; invented mnemonics remain explicitly separate. Ordinary conversation does not require dictionary calls, and reading the catalog never changes the personal graph.

Run `pnpm prepare:dictionary` explicitly to provision the local English-Wiktionary catalog for English, French and Russian. The catalog lives outside Git at `~/.local/share/balabol/dictionaries/wiktionary.sqlite`; override it with `BALABOL_DICTIONARY_PATH`. Startup never downloads dictionary data. A missing catalog is reported to the agent as `DictionaryUnavailable`, rather than an empty dictionary or a failed chat startup. Selected material can be saved separately through the existing personal-knowledge tools.

Provisioning streams the approximately 2.98 GB compressed English-Wiktionary archive and indexes only the selected languages into the separate catalog, never the personal graph. Run `pnpm prepare:dictionary --check` to verify an existing catalog without downloading. Catalog replacement is atomic; restart the backend afterward so its read-only connection opens the updated catalog.

Dictionary-derived text is attributed to Wiktionary contributors through the source entry URL and supplied under CC BY-SA 4.0. See [third-party data notices](THIRD_PARTY_NOTICES.md) for the license and extraction modifications; this data license does not apply to application code.

### Fresh checkout and external data

A Git checkout contains code, the source manifest and preparation commands, **not the dictionary SQLite catalog or its downloaded archive**. `pnpm dev:voice` (including `--check`) prints dictionary readiness before starting other services. Missing, corrupt or mismatched data is reported as `Dictionary: UNAVAILABLE` with the preparation command; this does not block ordinary chat. Direct backend startup also logs an unavailable catalog. The readiness check never creates an empty database or downloads data.

After a fresh checkout, run `pnpm prepare:dictionary --check`. If unavailable, run `pnpm prepare:dictionary`, repeat the check, then restart the backend. The preparation command verifies the archive's pinned SHA-256 before importing it. The upstream download URL rotates: if that snapshot is no longer available, preparation fails explicitly rather than accepting different bytes. Preserve `~/.local/share/balabol/dictionaries/wiktextract-en.jsonl.gz` in a backup to rebuild that exact snapshot independently of upstream retention. Git alone does not guarantee that snapshot remains downloadable.

The dictionary is rebuildable reference data. The conversation and personal knowledge databases are private user data, also excluded from Git; cloning cannot restore them. Back up their configured data locations separately before deleting local data. Deleting only the checkout leaves the default dictionary under `~/.local/share/balabol` intact.

### Soniox recognition trial

Set `BALABOL_RECOGNITION_PROVIDER=soniox` and `SONIOX_API_KEY` in the ignored local `.env` (mode `0600`) or backend environment, then run `pnpm dev:voice --real`. The voice launcher loads `.env`; explicit shell variables take precedence. Prefer a `.env` symlink to a mode-`0600` file outside the checkout (for example `~/.config/balabol/backend.env`), keeping actual credentials outside repository directory scans and checkouts. The key remains server-side and redacted in parsed configuration; never put it in Git, the iPhone app or chat. Missing credentials fail preflight with an actionable error. Real mode defaults to Soniox. Sol/Luna, tools and memory remain independent. Cloud audio processing is separately metered by Soniox.

The initial adapter uses `stt-rt-v5` over authenticated WebSocket with strict configured-language hints and token language identification. It accepts supplied PCM chunks from the current Voice pipeline, consumes provisional/final tokens, and requires the provider's explicit finished response before emitting Final. Early closure, malformed data, provider rejection, output capacity and the 30-second request deadline are explicit failures; cancellation closes the request socket without retrying paid requests automatically. Provider text is not copied into diagnostics.

**Trial boundary:** this adapter evaluates recognition quality and post-upload latency. Audio is currently uploaded after Voice has assembled a bounded chunk; it does not yet stream microphone frames while they are captured, and Soniox semantic endpointing is disabled so the existing Voice owner remains responsible for turn boundaries. Do not use this trial to claim end-to-end streaming latency. A live comparison requires a configured key and owner audio; deterministic fixtures establish protocol/lifecycle behavior only. Protocol grounding: [Soniox WebSocket API](https://soniox.com/docs/api-reference/stt/websocket-api) and [authentication](https://soniox.com/docs/guides/websocket-authentication).

### Switching the ChatGPT subscription account

Balabol owns a separate subscription connection; changing the Codex login or restarting the backend does not change it. On the loopback subscription setup page, use **Switch account** to clear the previous account registration and start authorization for the new account. Ordinary reconnect keeps the existing registration. If OpenAI reports that an app is restricted to its workspace, retry through Switch account rather than reusing the previous client registration; OpenAI still decides the new account's access.

Authentication failures are reported as ChatGPT authentication failures with reconnect/switch-account guidance. Subscription limits have a separate message. Only locally controlled failure descriptions cross the agent runtime into durable replies; provider payloads and credentials remain private.

### Soniox synthesis trial

Set `BALABOL_SYNTHESIS_PROVIDER=soniox` with the same server-side `SONIOX_API_KEY` used for recognition, then run `pnpm dev:voice --real`. Recognition and synthesis are independent selections. `BALABOL_SONIOX_VOICE` selects the voice (default `Adrian`); Soniox is the only real synthesis provider; deterministic `fake` remains available for development. No native speech helper, ffmpeg or installed voices are required. TTS is separately metered by Soniox; there is no automatic retry or provider fallback.

The Effect Layer uses [`tts-rt-v2` over WebSocket](https://soniox.com/docs/api-reference/tts/websocket-api), sends each complete bounded phrase and receives streaming 24 kHz mono PCM. RU/FR/EN and the Japanese extension are exposed through the existing language configuration. Soniox handles language mixing within a phrase. One scoped socket belongs to each phrase; cancellation closes it and fences late callbacks. Audio remains bounded to 60 seconds per phrase; only explicit successful stream termination completes synthesis. Authentication, billing, quota, network, malformed audio and premature termination fail explicitly without copying provider payloads into errors. Provider generation has a 60-second deadline; the independent overall response/playback budget defaults to five minutes.

Synthetic provider probes establish transport and timing only. Pronunciation, mixed-language quality and perceived latency still require listening in the iPhone application. Text is sent to Soniox for cloud synthesis; credentials remain on the backend. The adapter receives complete phrases rather than forwarding individual LLM tokens.
