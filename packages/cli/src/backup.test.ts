import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { runBackup } from "./backup.js"

/**
 * What a shop has in this database is not recoverable from anywhere else, and the product told
 * people to run it on their own machine while offering them no way to keep a copy.
 */

const dirs: string[] = []

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quidchat-backup-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("quidchat backup", () => {
  it("writes a real archive of a local database", async () => {
    const dir = await scratch()
    const out = join(dir, "backup.tgz")
    const result = await runBackup({
      env: { QUIDCHAT_DATA_DIR: join(dir, "data") },
      out,
      log: () => {},
    })

    expect(result).not.toBeNull()
    const bytes = await readFile(out)
    // A gzip member, not an empty file dressed as one: 1f 8b is the magic number, and an empty
    // file that looks like a backup is the failure this command exists to prevent.
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    expect(bytes.byteLength).toBeGreaterThan(1024)
  })

  it("names the file by the moment it was taken", async () => {
    const dir = await scratch()
    const result = await runBackup({
      env: { QUIDCHAT_DATA_DIR: join(dir, "data") },
      // No --out. The second question anyone asks of a backup file is how old it is, and
      // `backup.tgz` cannot answer it.
      now: new Date("2026-07-31T22:15:00Z"),
      log: () => {},
    })
    expect(result?.path).toBe("quidchat-backup-2026-07-31-22-15-00.tgz")
    await rm(result!.path, { force: true })
  })

  it("points at pg_dump for a managed database instead of pretending", async () => {
    const lines: string[] = []
    const result = await runBackup({
      env: { DATABASE_URL: "postgres://user:pw@db.example/quidchat" },
      log: (line) => lines.push(line),
    })
    expect(result).toBeNull()
    const printed = lines.join("\n")
    expect(printed).toContain("pg_dump")
    // The URL carries a password. Printing it back to a terminal, into whatever scrollback or
    // CI log is watching, is not something a backup command should do.
    expect(printed).not.toContain("pw@db.example")
  })
})
