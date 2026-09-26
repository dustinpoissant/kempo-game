import { triggerHook, getUserById, getUserByEmail } from 'kempo/server/sdk.js';
import { readConfig } from '../config/settings.js';
import { getType, loadModule } from '../types/types.js';
import getManager from '../live/getManager.js';
import {
  findGame, findPlayers, findPlayer, findGamesForUser, findAllGames, countOwnedGames, findUserNames,
  insertGame, insertInvite, updatePlayer, deletePlayer, updateGame, deleteGameRows,
} from './store.js';

/*
  The operations on games and their players, as the rest of kempo does them: plain data in, an
  `[error, data]` tuple out, and no HTTP objects anywhere.

  Like kempo-files' SDK these are the *data* operations. Whether the caller may do something is the
  routes' business, with one deliberate exception: pass `actorId` and the rules that belong to a game
  itself (only the owner invites, the owner cannot leave) are enforced here, since those are true
  whoever is asking. Leave it off for server-side code that has already decided it is allowed.
*/

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const notify = async (event, data) => {
  try {
    await triggerHook(event, data);
  } catch(error) {
    console.error(`[kempo-game] a ${event} hook failed: ${error?.message || error}`);
  }
};

/*
  A guard hook throws { code, msg } to refuse. Anything else it throws is a bug in that hook and must not
  leak: the player is told they were refused, and the cause goes to the log.
*/
const guard = async (event, data) => {
  try {
    await triggerHook(event, data, { bail: true });
    return null;
  } catch(error) {
    if(Number.isInteger(error?.code) && error.code >= 400 && error.code < 600 && typeof error.msg === 'string'){
      return { code: error.code, msg: error.msg };
    }
    console.error(`[kempo-game] ${event} failed: ${error?.message || error}`);
    return { code: 403, msg: 'You cannot do that right now' };
  }
};

const summary = row => ({
  id: row.id,
  type: row.type,
  name: row.name,
  ownerId: row.ownerId,
  settings: row.settings,
  stateVersion: row.stateVersion,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  savedAt: row.savedAt,
});

const playerShape = (row, names) => ({
  userId: row.userId,
  name: names.get(row.userId) || 'Player',
  role: row.role,
  status: row.status,
  invitedBy: row.invitedBy,
  invitedAt: row.invitedAt,
  joinedAt: row.joinedAt,
});

const playersOf = async (gameId) => {
  const rows = await findPlayers(gameId);
  const names = await findUserNames(rows.map(row => row.userId));
  return rows.map(row => playerShape(row, names));
};

/*
  Games
*/

export const createGame = async ({ ownerId, type, name, settings = {} } = {}) => {
  if(!ownerId) return [{ code: 400, msg: 'An owner is required' }, null];
  if(typeof name !== 'string' || !name.trim() || name.trim().length > 120){
    return [{ code: 400, msg: 'A game needs a name of 1 to 120 characters' }, null];
  }
  if(!isPlainObject(settings)) return [{ code: 400, msg: 'Settings must be an object' }, null];

  const definition = await getType(type);
  if(!definition) return [{ code: 400, msg: `Unknown game type "${type}"` }, null];

  const [ownerError] = await getUserById(ownerId);
  if(ownerError) return [ownerError.code === 404 ? { code: 404, msg: 'Owner not found' } : ownerError, null];

  const config = await readConfig();
  const merged = { ...definition.defaultSettings, ...settings };
  if(Buffer.byteLength(JSON.stringify(merged)) > config.maxSettingsBytes){
    return [{ code: 413, msg: `Settings are over the ${config.maxSettingsBytes} byte limit` }, null];
  }
  if(config.maxGamesPerUser > 0 && await countOwnedGames(ownerId) >= config.maxGamesPerUser){
    return [{ code: 429, msg: `You can own at most ${config.maxGamesPerUser} games` }, null];
  }

  let state = {};
  try {
    const module = await loadModule(definition);
    if(typeof module.onCreate === 'function'){
      state = await module.onCreate({ settings: structuredClone(merged), ownerId });
      if(state === undefined) state = {};
    }
  } catch(error) {
    console.error(`[kempo-game] ${definition.id} onCreate failed: ${error?.message || error}`);
    return [{ code: 500, msg: 'The game could not be set up' }, null];
  }
  if(!isPlainObject(state)) return [{ code: 500, msg: 'The game could not be set up' }, null];
  if(Buffer.byteLength(JSON.stringify(state)) > config.maxStateBytes){
    return [{ code: 413, msg: `The starting state is over the ${config.maxStateBytes} byte limit` }, null];
  }

  const row = await insertGame({ type: definition.id, name: name.trim(), ownerId, settings: merged, state });
  await notify('game:created', { gameId: row.id, type: row.type, ownerId });
  return [null, { game: summary(row) }];
};

export const getGame = async ({ gameId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];
  return [null, { game: { ...summary(row), state: row.state }, players: await playersOf(gameId), live: Boolean(getManager().get(gameId)) }];
};

export const listGames = async ({ userId } = {}) => {
  if(!userId) return [{ code: 400, msg: 'A user is required' }, null];

  const manager = getManager();
  const rows = await findGamesForUser(userId);
  const games = [];
  for(const { game, membership } of rows){
    const players = await findPlayers(game.id);
    games.push({
      ...summary(game),
      membership: { role: membership.role, status: membership.status, invitedBy: membership.invitedBy, invitedAt: membership.invitedAt },
      playerCount: players.filter(player => player.status === 'joined').length,
      live: Boolean(manager.get(game.id)),
    });
  }
  return [null, { games }];
};

export const listAllGames = async ({ limit, offset } = {}) => {
  const manager = getManager();
  const rows = await findAllGames({ limit, offset });
  const games = [];
  for(const row of rows){
    const players = await findPlayers(row.id);
    games.push({ ...summary(row), playerCount: players.filter(player => player.status === 'joined').length, live: Boolean(manager.get(row.id)) });
  }
  return [null, { games }];
};

export const updateGameDetails = async ({ gameId, actorId, name, settings } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];
  if(actorId && actorId !== row.ownerId) return [{ code: 403, msg: 'Only the owner can change a game' }, null];

  const values = {};
  if(name !== undefined){
    if(typeof name !== 'string' || !name.trim() || name.trim().length > 120){
      return [{ code: 400, msg: 'A game needs a name of 1 to 120 characters' }, null];
    }
    values.name = name.trim();
  }
  if(settings !== undefined){
    if(!isPlainObject(settings)) return [{ code: 400, msg: 'Settings must be an object' }, null];
    const config = await readConfig();
    if(Buffer.byteLength(JSON.stringify(settings)) > config.maxSettingsBytes){
      return [{ code: 413, msg: `Settings are over the ${config.maxSettingsBytes} byte limit` }, null];
    }
    values.settings = settings;
  }
  if(!Object.keys(values).length) return [{ code: 400, msg: 'Nothing to change' }, null];

  const updated = await updateGame(gameId, values);
  getManager().settingsChanged(gameId, updated.settings, updated.name);
  return [null, { game: summary(updated) }];
};

export const deleteGame = async ({ gameId, actorId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];
  if(actorId && actorId !== row.ownerId) return [{ code: 403, msg: 'Only the owner can delete a game' }, null];

  const live = getManager().get(gameId);
  if(live) await getManager().end(live, { reason: 'deleted', save: false });

  await deleteGameRows(gameId);
  await notify('game:deleted', { gameId, type: row.type, ownerId: row.ownerId });
  return [null, { deleted: true }];
};

/*
  Players
*/

export const invitePlayer = async ({ gameId, userId, email, invitedBy } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];
  if(invitedBy && invitedBy !== row.ownerId) return [{ code: 403, msg: 'Only the owner can invite players' }, null];

  let target = userId;
  if(!target){
    if(typeof email !== 'string' || !email.trim()) return [{ code: 400, msg: 'A user or an email is required' }, null];
    let [error, found] = await getUserByEmail(email.trim());
    if(error?.code === 404) [error, found] = await getUserByEmail(email.trim().toLowerCase());
    if(error) return [error.code === 404 ? { code: 404, msg: 'No account has that email' } : error, null];
    target = found.id;
  } else {
    const [error] = await getUserById(target);
    if(error) return [error.code === 404 ? { code: 404, msg: 'User not found' } : error, null];
  }

  const definition = await getType(row.type);
  if(!definition) return [{ code: 409, msg: `This game's type "${row.type}" is not installed or is disabled` }, null];

  const players = await findPlayers(gameId);
  const existing = players.find(player => player.userId === target);
  if(existing && existing.status === 'joined') return [{ code: 409, msg: 'That user is already in this game' }, null];
  if(existing && existing.status === 'invited') return [{ code: 409, msg: 'That user has already been invited' }, null];

  const taken = players.filter(player => player.status === 'joined' || player.status === 'invited').length;
  if(taken >= definition.maxPlayers) return [{ code: 409, msg: `This game is full (${definition.maxPlayers} players)` }, null];

  const player = existing
    ? await updatePlayer(gameId, target, { status: 'invited', invitedBy: invitedBy || row.ownerId, invitedAt: new Date(), joinedAt: null })
    : await insertInvite({ gameId, userId: target, invitedBy: invitedBy || row.ownerId });

  await notify('game:player_invited', { gameId, type: row.type, userId: target, invitedBy: player.invitedBy });
  const names = await findUserNames([target]);
  return [null, { player: playerShape(player, names) }];
};

export const acceptInvite = async ({ gameId, userId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];

  const membership = await findPlayer(gameId, userId);
  if(!membership || membership.status === 'declined') return [{ code: 404, msg: 'You have not been invited to this game' }, null];
  if(membership.status === 'joined') return [null, { player: playerShape(membership, await findUserNames([userId])) }];

  const definition = await getType(row.type);
  if(!definition) return [{ code: 409, msg: `This game's type "${row.type}" is not installed or is disabled` }, null];

  const players = await findPlayers(gameId);
  if(players.filter(player => player.status === 'joined').length >= definition.maxPlayers){
    return [{ code: 409, msg: 'This game is full' }, null];
  }

  const refusal = await guard('game:before_join', { gameId, type: row.type, userId, stage: 'accept' });
  if(refusal) return [refusal, null];

  const player = await updatePlayer(gameId, userId, { status: 'joined', joinedAt: new Date() });
  await getManager().refresh(gameId);
  await notify('game:player_joined', { gameId, type: row.type, userId });
  return [null, { player: playerShape(player, await findUserNames([userId])) }];
};

export const declineInvite = async ({ gameId, userId } = {}) => {
  const membership = await findPlayer(gameId, userId);
  if(!membership || membership.status !== 'invited') return [{ code: 404, msg: 'You have not been invited to this game' }, null];
  await updatePlayer(gameId, userId, { status: 'declined' });
  return [null, { declined: true }];
};

export const removePlayer = async ({ gameId, userId, actorId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];

  const membership = await findPlayer(gameId, userId);
  if(!membership) return [{ code: 404, msg: 'That user is not in this game' }, null];
  if(userId === row.ownerId){
    return [{ code: 409, msg: 'The owner cannot leave a game: transfer ownership first, or delete the game' }, null];
  }
  if(actorId && actorId !== userId && actorId !== row.ownerId){
    return [{ code: 403, msg: 'Only the owner can remove another player' }, null];
  }

  await deletePlayer(gameId, userId);
  await getManager().refresh(gameId);
  await notify('game:player_left', { gameId, type: row.type, userId, reason: actorId && actorId !== userId ? 'removed' : 'left' });
  return [null, { removed: true }];
};

export const leaveGame = ({ gameId, userId } = {}) => removePlayer({ gameId, userId, actorId: userId });

export const transferOwnership = async ({ gameId, toUserId, actorId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];
  if(actorId && actorId !== row.ownerId) return [{ code: 403, msg: 'Only the owner can transfer a game' }, null];
  if(toUserId === row.ownerId) return [{ code: 409, msg: 'That user already owns this game' }, null];

  const target = await findPlayer(gameId, toUserId);
  if(!target || target.status !== 'joined') return [{ code: 409, msg: 'A game can only be transferred to a player who has joined it' }, null];

  await updatePlayer(gameId, row.ownerId, { role: 'player' });
  await updatePlayer(gameId, toUserId, { role: 'owner' });
  await updateGame(gameId, { ownerId: toUserId });
  await getManager().refresh(gameId);
  await notify('game:ownership_changed', { gameId, type: row.type, from: row.ownerId, to: toUserId });
  return [null, { ownerId: toUserId }];
};

/*
  Playing
*/

/*
  Makes the game live on this process if it is not already, and says which channel to subscribe to. The
  channel exists before this returns, so a client that subscribes straight away is not refused for being
  early. Only a player who has joined may ask.
*/
export const joinGame = async ({ gameId, userId } = {}) => {
  const row = await findGame(gameId);
  if(!row) return [{ code: 404, msg: 'Game not found' }, null];

  const membership = await findPlayer(gameId, userId);
  if(!membership || membership.status !== 'joined') return [{ code: 403, msg: 'You are not a player in this game' }, null];

  const refusal = await guard('game:before_join', { gameId, type: row.type, userId, stage: 'play' });
  if(refusal) return [refusal, null];

  const [error, live] = await getManager().start(gameId);
  if(error) return [error, null];

  return [null, { gameId, channel: live.channel, type: live.type.id, name: live.name, tickRate: live.type.tickRate }];
};

export const saveGame = async ({ gameId } = {}) => {
  const live = getManager().get(gameId);
  if(!live) return [{ code: 409, msg: 'Only a game that is running can be saved' }, null];
  return getManager().save(live, { reason: 'manual' });
};

export const getSession = ({ gameId } = {}) => getManager().get(gameId)?.api || null;
