import { readFile } from "node:fs/promises"
import { Redacted } from "effect"
import type { LiveKitSettings } from "../src/voice/index.ts"
export const liveKitFixturePath = process.env.BALABOL_LIVEKIT_TEST_ENV
export const liveKitSettings = async (): Promise<LiveKitSettings> => {
  const values = new Map(
    (await readFile(liveKitFixturePath ?? "", "utf8")).split("\n").map((line) => {
      const at = line.indexOf("=")
      return [line.slice(0, at), line.slice(at + 1)]
    })
  )
  return {
    url: values.get("BALABOL_LIVEKIT_URL") ?? "",
    mediaUrl: values.get("BALABOL_LIVEKIT_MEDIA_URL") ?? "",
    apiKey: values.get("BALABOL_LIVEKIT_API_KEY") ?? "",
    apiSecret: Redacted.make(values.get("BALABOL_LIVEKIT_API_SECRET") ?? "")
  }
}
