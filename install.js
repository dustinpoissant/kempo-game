import { sql } from 'drizzle-orm';
import { db } from 'kempo/server/sdk.js';

/*
  The one thing that cannot be declared: indexes.

  kempo builds this extension's tables from their column definitions and does not read the indexes
  declared beside them. Without these, "is this user already in this game" and "which games am I in"
  would scan the whole membership table.

  Idempotent, like everything else in an install. It looks before it creates rather than using
  IF NOT EXISTS alone, because Postgres answers that with a notice on every run.
*/
export default async () => {
  const present = new Set((await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'kempoGamePlayer'`)).map(row => row.indexname));

  if(!present.has('kempoGamePlayerUnique')){
    await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "kempoGamePlayerUnique" ON "kempoGamePlayer" ("gameId", "userId")`);
  }
  if(!present.has('kempoGamePlayerByUser')){
    await db.execute(sql`CREATE INDEX IF NOT EXISTS "kempoGamePlayerByUser" ON "kempoGamePlayer" ("userId")`);
  }
};
