import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"

const maximumBytes = 4194304
const privateFileMode = 0o600
const privateDirectoryMode = 0o700
export interface AuditStorage {
  readonly write: (line: string) => Promise<void>
}
export const auditFile = (path: string): AuditStorage => ({
  async write(line) {
    const bytes = Buffer.byteLength(line)
    if (bytes > maximumBytes) throw new Error("Audit record exceeds file capacity")
    await mkdir(dirname(path), { recursive: true, mode: privateDirectoryMode })
    await chmod(dirname(path), privateDirectoryMode)
    const size = await stat(path).then(
      async (file) => {
        await chmod(path, privateFileMode)
        return file.size
      },
      (error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0
        throw error
      }
    )
    if (size + bytes > maximumBytes) await rename(path, `${path}.previous`)
    await appendFile(path, line, { mode: privateFileMode })
    await chmod(path, privateFileMode)
  }
})
