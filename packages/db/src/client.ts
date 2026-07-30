import { PGlite } from "@electric-sql/pglite"
import { vector } from "@electric-sql/pglite-pgvector"
import { drizzle as drizzlePglite } from "drizzle-orm/pglite"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type DbConfig =
  | { kind: "pglite"; dataDir?: string }
  | { kind: "postgres"; url: string }

export type QuidDb =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePostgres<typeof schema>>

export async function createDb(config: DbConfig): Promise<QuidDb> {
  if (config.kind === "pglite") {
    const client = config.dataDir
      ? await PGlite.create(config.dataDir, { extensions: { vector } })
      : await PGlite.create({ extensions: { vector } })
    return drizzlePglite(client, { schema })
  }
  return drizzlePostgres(postgres(config.url, { max: 10 }), { schema })
}
