import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { failed, PersistentState } from "./model.ts"
import type { SubscriptionPorts } from "./ports.ts"
const directoryMode = 0o700
const fileMode = 0o600
const permissionMask = 0o777
const storageFailure = () => failed("Storage", "Protected subscription storage is unavailable")
const validatePath = (path: string, directory: boolean) => {
  const info = lstatSync(path)
  const expected = directory ? directoryMode : fileMode
  if (info.isSymbolicLink() || (info.mode & permissionMask) !== expected || info.uid !== process.getuid?.())
    throw new Error("Unsafe subscription path")
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Unexpected subscription path")
}
const atomicWrite = (directory: string, path: string, state: unknown) => {
  const temporary = join(directory, `.connection-${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      fileMode
    )
    writeFileSync(descriptor, JSON.stringify(state), "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    const parent = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}
export const protectedStore = (input: string, hostId: () => string) =>
  Effect.gen(function* () {
    const directory = resolve(input)
    const lease = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          mkdirSync(directory, { recursive: true, mode: directoryMode })
          validatePath(directory, true)
          const leasePath = join(directory, "connection.writer")
          // Pre-create without following symlinks before SQLite opens its lease file.
          const descriptor = openSync(leasePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, fileMode)
          try {
            fchmodSync(descriptor, fileMode)
          } finally {
            closeSync(descriptor)
          }
          validatePath(leasePath, false)
          const database = new DatabaseSync(leasePath)
          try {
            database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")
          } catch (error) {
            database.close()
            throw error
          }
          return database
        },
        catch: storageFailure
      }),
      (database) => Effect.sync(() => database.close())
    )
    void lease
    const path = join(directory, "connection.json")
    const store: Pick<SubscriptionPorts, "load" | "save"> = {
      load: () =>
        Effect.try({
          try: () => {
            if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
              const initial = { hostId: hostId() }
              atomicWrite(directory, path, initial)
              return Schema.decodeUnknownSync(PersistentState)(initial)
            }
            validatePath(path, false)
            const maximumFileBytes = 131072
            if (lstatSync(path).size > maximumFileBytes) throw new Error("Oversized subscription state")
            const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
            return Schema.decodeUnknownSync(PersistentState)(parsed)
          },
          catch: storageFailure
        }),
      save: (state) =>
        Effect.try({
          try: () => {
            validatePath(directory, true)
            atomicWrite(directory, path, Schema.encodeSync(PersistentState)(state))
          },
          catch: storageFailure
        })
    }
    return store
  })
