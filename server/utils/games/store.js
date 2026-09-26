import { randomUUID } from 'crypto';
import { and, eq, inArray, sql, asc, desc } from 'drizzle-orm';
import { db, schema } from 'kempo/server/sdk.js';
import { kempoGame, kempoGamePlayer } from '../../db/schema.js';

/*
  The rows, and nothing else: no permission decisions, no rules, no hooks. Everything above this file
  works with plain objects and asks these functions to read and write them.
*/

export const newId = () => randomUUID();

export const findGame = async (gameId) => {
  if(!gameId) return null;
  const [row] = await db.select().from(kempoGame).where(eq(kempoGame.id, gameId)).limit(1);
  return row || null;
};

export const findPlayers = (gameId) => db
  .select()
  .from(kempoGamePlayer)
  .where(eq(kempoGamePlayer.gameId, gameId))
  .orderBy(asc(kempoGamePlayer.invitedAt));

export const findPlayer = async (gameId, userId) => {
  const [row] = await db
    .select()
    .from(kempoGamePlayer)
    .where(and(eq(kempoGamePlayer.gameId, gameId), eq(kempoGamePlayer.userId, userId)))
    .limit(1);
  return row || null;
};

/*
  Every game a user is in, or has been invited to, with their own membership beside it. A game whose
  invitation was declined is left out: it is no longer anything to do with them.
*/
export const findGamesForUser = async (userId) => {
  const rows = await db
    .select({ game: kempoGame, membership: kempoGamePlayer })
    .from(kempoGamePlayer)
    .innerJoin(kempoGame, eq(kempoGame.id, kempoGamePlayer.gameId))
    .where(and(eq(kempoGamePlayer.userId, userId), inArray(kempoGamePlayer.status, ['invited', 'joined'])))
    .orderBy(desc(kempoGame.updatedAt));
  return rows;
};

export const findAllGames = ({ limit = 200, offset = 0 } = {}) => db
  .select()
  .from(kempoGame)
  .orderBy(desc(kempoGame.updatedAt))
  .limit(limit)
  .offset(offset);

export const countOwnedGames = async (ownerId) => {
  const [row] = await db.select({ n: sql`count(*)::int` }).from(kempoGame).where(eq(kempoGame.ownerId, ownerId));
  return row.n;
};

/*
  Names for a set of user ids. Only what a screen needs to draw a player; never an email or anything
  else, so nothing here can leak into a payload meant for other players.
*/
export const findUserNames = async (userIds) => {
  const names = new Map();
  if(!userIds.length) return names;
  const rows = await db
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(inArray(schema.user.id, [...new Set(userIds)]));
  for(const row of rows) names.set(row.id, row.name);
  return names;
};

export const insertGame = async ({ id = newId(), type, name, ownerId, settings, state }) => {
  const now = new Date();
  await db.transaction(async transaction => {
    await transaction.insert(kempoGame).values({ id, type, name, ownerId, settings, state, stateVersion: 0, createdAt: now, updatedAt: now });
    await transaction.insert(kempoGamePlayer).values({
      id: newId(), gameId: id, userId: ownerId, role: 'owner', status: 'joined',
      invitedBy: null, invitedAt: now, joinedAt: now, data: {},
    });
  });
  return findGame(id);
};

export const insertInvite = async ({ gameId, userId, invitedBy }) => {
  const now = new Date();
  await db.insert(kempoGamePlayer).values({
    id: newId(), gameId, userId, role: 'player', status: 'invited',
    invitedBy, invitedAt: now, joinedAt: null, data: {},
  });
  return findPlayer(gameId, userId);
};

export const updatePlayer = async (gameId, userId, values) => {
  await db
    .update(kempoGamePlayer)
    .set(values)
    .where(and(eq(kempoGamePlayer.gameId, gameId), eq(kempoGamePlayer.userId, userId)));
  return findPlayer(gameId, userId);
};

export const deletePlayer = (gameId, userId) => db
  .delete(kempoGamePlayer)
  .where(and(eq(kempoGamePlayer.gameId, gameId), eq(kempoGamePlayer.userId, userId)));

export const updateGame = async (gameId, values) => {
  await db.update(kempoGame).set({ ...values, updatedAt: new Date() }).where(eq(kempoGame.id, gameId));
  return findGame(gameId);
};

export const deleteGameRows = async (gameId) => {
  await db.transaction(async transaction => {
    await transaction.delete(kempoGamePlayer).where(eq(kempoGamePlayer.gameId, gameId));
    await transaction.delete(kempoGame).where(eq(kempoGame.id, gameId));
  });
};

/*
  The save. It only lands if the version in the database is the one this process last read, and then
  bumps it, so two processes that both believe they are hosting a game cannot overwrite each other.
  Returns the new version, or null when someone else got there first.

  The players' own data goes in the same transaction: a save is one moment, not two.
*/
export const saveState = async ({ gameId, state, expectedVersion, players }) => {
  return db.transaction(async transaction => {
    const now = new Date();
    const updated = await transaction
      .update(kempoGame)
      .set({ state, stateVersion: expectedVersion + 1, savedAt: now, updatedAt: now })
      .where(and(eq(kempoGame.id, gameId), eq(kempoGame.stateVersion, expectedVersion)))
      .returning({ stateVersion: kempoGame.stateVersion });

    if(!updated.length) return null;

    for(const { userId, data } of players){
      await transaction
        .update(kempoGamePlayer)
        .set({ data })
        .where(and(eq(kempoGamePlayer.gameId, gameId), eq(kempoGamePlayer.userId, userId)));
    }
    return updated[0].stateVersion;
  });
};
