import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { SqliteStorage } from "../src/memory/sqlite.ts"
import { temporaryDatabase } from "./memory-fixture.ts"

const payload = { deliveryId: "11111111-1111-4111-8111-111111111111", text: "hello" }
it("atomically rolls back an invalid raw batch and immutable node; checkpoints survive reopen", async () => {
  const fixture = await temporaryDatabase()
  const storage = new SqliteStorage(fixture.path)
  try {
    await storage.open()
    await expect(storage.open()).rejects.toThrow("already opened")
    storage.prepare(payload)
    await expect(
      storage.appendRecords([
        { id: 0, kind: "user", text: "hello", date: "2026-10-13" },
        { id: 2, kind: "user", text: "bad", date: "2026-10-13" }
      ])
    ).rejects.toThrow("Noncontiguous")
    expect((await storage.load()).records).toHaveLength(0)
    expect(storage.find(payload.deliveryId)?.firstId).toBeNull()
    await storage.appendRecords([{ id: 0, kind: "user", text: "hello", date: "2026-10-13" }])
    storage.prepare(payload)
    await expect(storage.appendRecords([{ id: 1, kind: "user", text: "hello", date: "2026-10-13" }])).rejects.toThrow(
      "exactly one"
    )
    expect((await storage.load()).records).toHaveLength(1)
    await storage.appendNode({ level: 0, index: 0, text: "user: hello" })
    await expect(storage.appendNode({ level: 0, index: 0, text: "changed" })).rejects.toThrow()
    const checkpoint = {
      version: 1,
      cursor: 1,
      main: [{ level: 0, index: 0 }],
      compaction: [{ level: 0, index: 0 }],
      mainBatching: false,
      compactionBatching: false
    }
    await storage.checkpoint({ ...checkpoint, version: 1 })
    await storage.close()
    const reopened = new SqliteStorage(fixture.path)
    try {
      await reopened.open()
      const image = await reopened.load()
      expect(image.checkpoint).toEqual(checkpoint)
      expect(image.nodes).toEqual([{ level: 0, index: 0, text: "user: hello" }])
      const first = image.records[0]
      if (first !== undefined) first.text = "changed"
      expect((await reopened.load()).records[0]?.text).toBe("hello")
    } finally {
      await reopened.close()
    }
  } finally {
    await storage.close()
    await fixture.close()
  }
})
it("rejects competing writers including a symlink alias and permits reacquisition after release", async () => {
  const fixture = await temporaryDatabase()
  const storage = new SqliteStorage(fixture.path)
  try {
    expect(() => new SqliteStorage(fixture.path)).toThrow()
    const alias = join(fixture.directory, "alias.sqlite")
    await symlink(fixture.path, alias)
    expect(() => new SqliteStorage(alias)).toThrow()
    await storage.close()
    const next = new SqliteStorage(alias)
    await next.close()
  } finally {
    await storage.close()
    await fixture.close()
  }
})
