import { Memory } from "@firfi/unii"
import { SqliteStorage } from "../src/memory/sqlite.ts"

const path = process.argv[2]
if (path === undefined) throw new Error("Missing fixture path")
const storage = new SqliteStorage(path)
const core = await Memory.open({
  storage: {
    open: () => storage.open(),
    load: () => storage.load(),
    close: () => storage.close(),
    checkpoint: (checkpoint) => storage.checkpoint(checkpoint),
    appendNode: (node) => storage.appendNode(node),
    appendRecords: async (records) => {
      await storage.appendRecords(records)
      // An unresolved Promise does not keep Node alive; hold IPC until the parent sends SIGKILL.
      process.channel?.ref()
      process.send?.("raw-committed")
      await new Promise<void>(() => {})
    }
  }
})
storage.prepare({ deliveryId: "11111111-1111-4111-8111-111111111111", text: "crash window" })
await core.append({ kind: "user", text: "crash window" })
