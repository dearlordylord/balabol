# Balabol

**Purpose:** Describe the repository and its current development state.
**Status:** Durable text conversation slice and complete TS quality tooling; voice and replies are not implemented.
**Authority:** Product requirements live in the published prototype issue; engineering guidance lives in AGENTS.md.
**Expected use:** Start here before contributing.
**Lifecycle:** Update when the product spec, setup or implementation status changes.

An iOS-first personal voice assistant with one enduring conversation. SwiftUI/MVVM client, TypeScript/Effect backend, @firfi/unii memory. Initial speech, answer and summary providers are deterministic fakes; local speech and subscription model integration are deferred.

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
4. In the app's **Connect to Balabol** screen, enter `http://127.0.0.1:8787` in the URL field and tap **Connect**.
5. Enter text in **Message** and tap **Send**. Relaunch the app to verify the single saved transcript remains. Replies and voice are not implemented yet.

For a physical iPhone, choose your local signing team in Xcode. Connect Tailscale on both devices, start the backend with `BALABOL_HOST=<Mac Tailscale IP> pnpm start`, and enter `http://<Mac Tailscale IP>:8787` in the app. The default loopback address is for Simulator; the phone needs the Mac's Tailscale address. Both processes must run while sending. If you customize `BALABOL_PORT`, use the matching port in the app URL.

## Repository tooling

Use Node >=22.19 and <25 (Node 24 is supported) and the pinned pnpm. Install gitleaks separately (macOS: brew install gitleaks), then run `pnpm install --strict-peer-dependencies` to activate Husky.

Run pnpm check:repository for formatting and staged-secret checks; pnpm secrets:files scans the working tree and pnpm secrets:history scans Git history. Pre-commit scans staged content before formatting. Pre-push scans history. Missing gitleaks fails the hooks.

Run `pnpm check-all` for the complete quality gate and `pnpm test:harness` for isolated positive/negative tooling self-checks. The [quality harness](docs/engineering/quality-harness.md) documents the pinned cohort and numeric limits; the [ownership map](docs/engineering/ownership.md) owns initial dependency boundaries. Product compiler/test/CRAP gates become active as source is added; absent product source is explicitly pending, not passing product acceptance. Speech engines and model weights are not installed by repository setup.

## Local text backend

Run `pnpm build`, then `node dist/bootstrap/main.js`. Startup parses `BALABOL_HOST` (default `127.0.0.1`), `BALABOL_PORT` (default `8787`) and `BALABOL_DATABASE` (default `.data/conversation.sqlite`). Bind explicitly to the Mac's Tailscale address for the phone; this prototype endpoint assumes the private development network and does not provide internet-facing authentication.

`POST /conversation/messages` accepts `{deliveryId: UUID, text: string}` and returns `{deliveryId, text, recordId, position}` only after durable acceptance. Keep the same identity and original payload after uncertain delivery. Conflicting reuse returns `409 DeliveryConflict`; invalid input returns `400 InvalidInput`; unavailable memory returns `503 StorageUnavailable`. A post-raw memory failure can make the first outcome uncertain while retry returns the already durable receipt. The next admitted send automatically reconstructs the failed unii session from durable state while retaining exclusive writer ownership; no backend restart is required. Persistent storage failure returns a typed error after one recovery attempt per send. Later sends retry recovery after storage becomes available.

`GET /conversation/messages?limit=100` starts history. Continue with `after=<position>` (exclusive); positions start at zero. Responses contain `messages` and `nextAfter`, null when fewer than the requested limit remain. A full final page may require one empty follow-up read. Delivery positions identify whole messages; unii can split a message into several raw records, and `recordId` identifies its first record. Text is nonempty and limited to 100,000 UTF-16 code units; history pages contain at most 100 messages.

SQLite commits raw batches and their delivery receipt together, uses WAL/FULL with macOS fullfsync, and holds a scoped OS-released exclusive writer lease. Keep the database and companion `.writer` file on the same local durable filesystem; canonical symlink paths share the lease. Hard-link database aliases and shared network filesystems are unsupported. Acknowledgement does not promise ready summaries. Transcript reads are bounded SQL queries; the current unii contract still hydrates the complete memory journal at startup.

## iOS text client

Open `ios/Balabol.xcodeproj`, select the `Balabol` scheme, and run on an iOS 17+ simulator or device. For a device, select your local signing team in Xcode. Start the backend with `BALABOL_HOST=<Mac Tailscale IP>` and enter `http://<Mac Tailscale IP>:8787` in the app. The simulator can use `http://127.0.0.1:8787`.

Send text, reload the app and backend, and verify it remains in the single transcript. Stop the backend before sending to exercise an uncertain result: the draft remains, and retry uses the same identity when the backend returns. A definite invalid/conflicting request preserves editable text; uncertain outcomes preserve the exact pending payload. Server changes are blocked while a delivery remains unresolved.

Run `swift test --package-path ios` for Swift intent/projection tests. With a temporary backend running, `BALABOL_TEST_SERVER=http://127.0.0.1:8787 swift test --package-path ios --filter LiveBackendTests` also exercises the production HTTP adapter. This opt-in test writes fixture messages; use an isolated database rather than personal conversation data. Simulator checks do not qualify physical iPhone or background audio behavior.
