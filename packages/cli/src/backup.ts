import { writeFile } from "node:fs/promises"
import { createDb, dumpDatabase } from "@quidchat/db"
import { readServeConfig } from "./config.js"

/**
 * A copy of everything, in one file.
 *
 * What a shop has in here is not recoverable from anywhere else: the documents it wrote out, the
 * canned answers it approved sentence by sentence, and every conversation its customers had. The
 * product told people to run it on their own machine and then offered them no way to keep a copy
 * of that, which is a strange thing to leave to a directory copy — and copying PGlite's directory
 * while the server holds it open is how a backup turns out to be unrestorable at the moment
 * somebody needs it.
 *
 * This dumps through the running engine, so what lands in the file is a consistent snapshot.
 *
 * On a managed Postgres it does not pretend: `pg_dump` is the tool, it already exists, and every
 * provider's own documentation covers it. Wrapping it here would add a way to get it wrong.
 */
export async function runBackup(args: {
  env: Record<string, string | undefined>
  out?: string
  now?: Date
  log?: (line: string) => void
}): Promise<{ path: string; bytes: number } | null> {
  const log = args.log ?? ((line: string) => console.log(line))
  const config = readServeConfig(args.env)

  if (config.db.kind !== "pglite") {
    log("This deployment uses a managed Postgres, so its own tools make the backup:")
    log("")
    log('  pg_dump "$QUIDCHAT_DATABASE_URL" --format=custom --file=quidchat.dump')
    log("")
    log("Restore it with pg_restore against an empty database.")
    return null
  }

  const db = await createDb(config.db)
  const dump = await dumpDatabase(db)
  if (!dump) {
    // Only reachable if the tiers and this check ever disagree, which is worth saying out loud
    // rather than writing an empty file that looks like a backup.
    log("could not read this database for backup")
    return null
  }

  // Named by the moment it was taken, because the second question anyone asks of a backup file is
  // how old it is, and a file called `backup.tgz` cannot answer it.
  const stamp = (args.now ?? new Date()).toISOString().slice(0, 19).replace(/[:T]/g, "-")
  const path = args.out ?? `quidchat-backup-${stamp}.tgz`
  await writeFile(path, dump)
  log(`wrote ${path} (${(dump.byteLength / 1024 / 1024).toFixed(1)} MB)`)
  log("")
  log("To restore, stop the server and put this back as the data directory:")
  log(`  tar -xzf ${path} -C "${config.db.dataDir ?? ".quidchat/data"}"`)
  return { path, bytes: dump.byteLength }
}
