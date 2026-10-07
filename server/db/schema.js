import { pgTable, text, integer, timestamp, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';

/*
  Two tables, and nothing in either of them knows what a game is *about*.

  `settings` and `state` are documents. A game type decides their shape; this extension only stores
  them and never looks inside. That is what lets the same two tables hold a small board game and,
  one day, a world with a hundred thousand blocks.

  What is kept here is what has to survive a restart. Positions and other things that change many
  times a second are not: they live in memory for as long as a game is running and are never written
  by the sync path (see server/utils/live).
*/
export const kempoGame = pgTable('kempoGame', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                       // <extension>:<type>, as declared in that extension's kempo-config.json
  name: text('name').notNull(),
  ownerId: text('ownerId').notNull(),                 // no FK, matching the other kempo extensions
  settings: jsonb('settings').notNull().default({}),
  state: jsonb('state').notNull().default({}),

  /*
    Bumped by every save, and what a save is compared against. A save only lands if the version in
    the database is the one this process last read, so two processes hosting the same game cannot
    quietly overwrite each other.
  */
  stateVersion: integer('stateVersion').notNull().default(0),

  createdAt: timestamp('createdAt').notNull(),
  updatedAt: timestamp('updatedAt').notNull(),
  savedAt: timestamp('savedAt'),                      // null until the first save
});

/*
  Membership. A row per user per game, from the moment they are invited.

  `status` is what makes an invitation a thing that can be declined without deleting the record of it
  having been offered: `invited` then `joined` or `declined`. Only `joined` players can open the live
  channel, send input or read state.

  `data` is per-player data that is saved with the game: a level, an inventory, a spawn point. Like
  `state` it is a document this extension never reads.
*/
export const kempoGamePlayer = pgTable('kempoGamePlayer', {
  id: text('id').primaryKey(),
  gameId: text('gameId').notNull(),
  userId: text('userId').notNull(),
  role: text('role').notNull(),                       // owner | player
  status: text('status').notNull(),                   // invited | joined | declined
  invitedBy: text('invitedBy'),
  invitedAt: timestamp('invitedAt').notNull(),
  joinedAt: timestamp('joinedAt'),
  data: jsonb('data').notNull().default({}),
}, table => [
  /*
    A user is in a game at most once, and "my games" is asked far more often than any other question.
    kempo creates this extension's tables from the column definitions and does not read indexes, so
    install.js creates these two as well; they are declared here so a database built from this schema
    (the test database) has them too.
  */
  uniqueIndex('kempoGamePlayerUnique').on(table.gameId, table.userId),
  index('kempoGamePlayerByUser').on(table.userId),
]);
