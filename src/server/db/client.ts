import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>

let instance: Db | undefined

function init(): Db {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and fill it in.',
    )
  }
  const client = postgres(url, { prepare: false })
  return drizzle(client, { schema })
}

export const db = new Proxy({} as Db, {
  get(_, prop, receiver) {
    instance ??= init()
    return Reflect.get(instance, prop, receiver)
  },
})
