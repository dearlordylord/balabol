# Subscription model integration evidence

Date: 2026-10-13. Research only; no inference request, credential inspection, or prototype implementation.

## Conclusion

A subscription-only integration is feasible through an owned Codex app-server process, following the existing slopchat boundary. Local catalog identifiers are `gpt-6.1-sol` for the currently configured answer model and `gpt-6-luna` as the newest advertised Luna. Neither catalog presence nor saved login proves a successful inference entitlement. Keep answer and summary roles explicit; do not silently select mini/nano alternatives. A small acceptance spike must verify both exact models, first-text latency, stream cancellation, and the capability surface before locking this adapter.

A second supported route is application-specific Sign in with ChatGPT plus direct Responses streaming. It gives a cleaner inference-only capability boundary, but introduces its own authorization lifecycle. It must not be treated as permission to copy Codex credentials into arbitrary HTTP requests.

## Measured local facts

- `codex --version`: `codex-cli 0.162.1`.
- Safely filtered user config reports `model = "gpt-6.1-sol"`, reasoning effort `low`. No credential files were read.
- A short-lived app-server was initialized, queried with `account/read` and `model/list`, then terminated. Sanitized account type is `chatgpt`; `requiresOpenaiAuth` is true (authentication requirement, not failure).
- Advertised catalog includes `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-luna`. No inference was performed, and catalog provenance/entitlements were not validated.

## Existing slopchat behavior

[slopchat-codex.el](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat-codex.el:244) owns a stdio child process, forces ChatGPT login, checks account type, disables built-in memory, shell, child agents, apps, plugins, hooks, browser/computer/image tools and web search. It disables every configured MCP server per thread rather than modifying user config; project documents are suppressed.

The transport exposes notification callbacks, collects completed agent messages, correlates turns and calls `turn/interrupt` on timeout. [slopchat-model.el](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat-model.el:20) uses fresh ephemeral response threads, returns requested tool calls to the outer agent, interrupts at their boundary and cleans up subscriptions. Its `eval` tool is specific to the Lisp agent and must NOT be copied into Balabol. [Summary selection](/Users/firfi/work/formal-proofs/slopchat/lisp/slopchat.el:61) currently chooses the first catalog match for luna/mini/nano; Balabol should use an explicit Luna identifier. Summary responses reject tools.

Important gap: thread creation uses danger-full-access when tools exist, read-only otherwise. Read-only still permits reads; disabled flags are not a demonstrated OS isolation boundary. This code is useful evidence, not a security contract to copy unchanged. Configuration flags are version-sensitive.

## Official interfaces

The [app-server protocol](https://learn.chatgpt.com/docs/app-server) documents `item/agentMessage/delta` streaming and `turn/interrupt` with thread and turn IDs; interruption terminates with interrupted status. Treat interruption acknowledgment separately from terminal completion. The server itself also offers command execution RPCs; the application adapter must expose a narrow inference interface, never generic RPC forwarding to agent or phone.

[Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) documents account-specific catalog discovery using the same OAuth access token as inference and selected `slug` values. App-server catalogs may be cached/bundled. Streaming can fail after text begins; only terminal completed events mean success. Partial output is not a successful answer or summary.

[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) describes app-specific dynamic client registration, PKCE, host identity, granted ChatGPT-plan scopes, protected app credential storage, and refresh tokens. This flow requires user authorization, not an API key. It is a distinct integration from using Codex's existing saved login.

[ChatGPT-plan app-server configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) supports an OAuth token supplied to a Responses provider, stdio RPC, and application-owned refresh. An environment-token renewal requires process restart and thread resume. This is an alternative to slopchat's existing Codex-native login; do not conflate their token management.

[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) exclude audio/transcription on this subscription route. STT/TTS need separate providers. Function/custom tools can be supplied, but local shell/MCP functionality is separate and must be excluded. This route uses stream=true/store=false; unii remains canonical memory.

## Proposed ownership and lifecycle

Effect service owns subprocess acquisition/release, RPC correlation, stream translation and cancellation finalizers. Domain callers receive text deltas and typed terminal outcomes, not raw Codex RPC. Answer and Summary are separate operations/model configuration; summarization receives bounded source text and zero tools. Agent only receives explicitly named memory handlers. Do not inherit a generic shell/filesystem/tool router or ambient project instructions.

On user interruption: stop audio promptly, request model interruption, reject late deltas from the superseded generation, await or bound terminal shutdown; do not confuse this with proof of server-side cancellation. A caller's deadline or disconnect must release resources. Credential handling stays entirely on backend. Hosted migration needs a new host/authentication decision rather than shipping user credential files with deployment.

## Remaining acceptance evidence

1. Completed short inference for both exact configured models under saved subscription, with no API-key fallback.
2. Observed first-delta latency and turn interruption; measure acknowledgment and final terminal separately.
3. A capability-surface test on pinned CLI version proving only memory tools are offered; no shell/file/MCP commands or project docs reachable. Decide process isolation/read policy explicitly.
4. Distinguish cancellation from failed/completed and prohibit partial summaries being committed by unii.
5. Compare native app-server auth with app-specific SIWC only if native route cannot provide required isolation or deployment lifecycle.
