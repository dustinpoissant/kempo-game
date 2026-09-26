import { realtime, triggerHook } from 'kempo/server/sdk.js';
import LiveGame from './LiveGame.js';
import { OWNER, readConfig } from '../config/settings.js';
import { getType, loadModule } from '../types/types.js';
import { findGame, findPlayers, findUserNames, saveState, deletePlayer } from '../games/store.js';

export const CHANNEL_PREFIX = `${OWNER}:g-`;
export const PLAY_PERMISSION = 'game:play';

const MAX_TICK_ERRORS = 10;

const asError = (error, fallback) => (
  Number.isInteger(error?.code) && typeof error?.msg === 'string' ? { code: error.code, msg: error.msg } : fallback
);

const defaultTimers = () => ({
  setInterval: (...args) => setInterval(...args),
  clearInterval: (...args) => clearInterval(...args),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
});

/*
  Runs the games that are live on this process.

  A game is live from the first time someone joins it until it has been empty for a while, or it is
  deleted, or the process stops. While live it has one realtime channel, an in-memory session, a save
  timer and, if its type has a tick rate, a step timer. None of that exists for a game nobody is in, so
  a site with a thousand saved games and ten people playing runs ten.

  The channel has `scope: "process"`. It is delivered in memory to the connections this process holds and
  never touches Postgres, which is what makes twenty updates a second from each of twenty players
  affordable. The price is that everyone in a game must reach the same process, so a site running several
  needs to route by game id; see the README. A save is compared against the version in the database, so
  two processes that both believe they host a game cannot quietly overwrite one another.

  Everything that leaves this class as a realtime message goes through one promise chain per channel, so
  two patches published in a row arrive in the order they were made.
*/
export default class Manager {
  #games = new Map();
  #channels = new Map();
  #starting = new Map();
  #chains = new Map();
  #realtime;
  #hook;
  #timers;
  #now;
  #log;

  constructor({ realtime: realtimeApi = realtime, triggerHook: hook = triggerHook, timers, now = () => Date.now(), log = console } = {}){
    this.#realtime = realtimeApi;
    this.#hook = hook;
    this.#timers = { ...defaultTimers(), ...timers };
    this.#now = now;
    this.#log = log;
  }

  /*
    Looking
  */

  get = gameId => this.#games.get(gameId) || null;
  byChannel = channel => this.#channels.get(channel) || null;
  list = () => [...this.#games.values()];

  /*
    Going live
  */

  start = (gameId) => {
    const existing = this.#games.get(gameId);
    if(existing && !existing.runtime.ending) return Promise.resolve([null, existing]);
    // A game that is still saving and closing must finish before a new session can take its channel
    if(existing) return existing.runtime.ending.then(() => this.start(gameId));

    // Two people joining at once must end up in the same session, not two
    if(!this.#starting.has(gameId)){
      const starting = this.#start(gameId).finally(() => this.#starting.delete(gameId));
      this.#starting.set(gameId, starting);
    }
    return this.#starting.get(gameId);
  };

  #start = async (gameId) => {
    const row = await findGame(gameId);
    if(!row) return [{ code: 404, msg: 'Game not found' }, null];

    const type = await getType(row.type);
    if(!type) return [{ code: 409, msg: `This game's type "${row.type}" is not installed or is disabled` }, null];

    let module;
    try {
      module = await loadModule(type);
    } catch(error) {
      this.#log.error(`[kempo-game] the rules for ${type.id} could not be loaded: ${error.message}`);
      return [{ code: 500, msg: 'This game\'s rules could not be loaded' }, null];
    }

    const players = (await findPlayers(gameId)).filter(player => player.status === 'joined');
    const names = await findUserNames(players.map(player => player.userId));
    const config = await readConfig();

    const live = new LiveGame({
      game: row,
      type,
      module,
      members: players.map(player => ({ userId: player.userId, name: names.get(player.userId) || 'Player', role: player.role, data: player.data })),
      channel: `${CHANNEL_PREFIX}${gameId}`,
      deps: {
        publish: (channel, data) => this.#publish(channel, data),
        direct: (connectionId, data) => this.#realtime.sendToConnection({ connectionId, data }),
        save: game => this.save(game, { reason: 'requested' }),
        log: this.#log,
      },
    });
    live.runtime = { config, autosave: null, tick: null, idle: null, removal: new Map(), saving: Promise.resolve(), ending: null, ended: false, tickErrors: 0, lastTick: this.#now() };

    await live.run('onLoad', { session: live.api });

    const registerError = this.#register(live);
    if(registerError) return [registerError, null];

    this.#games.set(gameId, live);
    this.#channels.set(live.channel, live);

    const autosave = type.autosaveSeconds ?? config.autosaveSeconds;
    if(autosave > 0){
      live.runtime.autosave = this.#timers.setInterval(() => this.#autosave(live), autosave * 1000);
      live.runtime.autosave?.unref?.();
    }
    this.#startIdle(live);

    await this.#notify('game:started', { gameId, type: type.id });
    return [null, live];
  };

  #register = (live) => {
    const options = {
      owner: OWNER,
      name: live.channel.slice(OWNER.length + 1),
      permission: PLAY_PERMISSION,
      authorize: ({ user }) => live.isMember(user.id),
      scope: 'process',
      dropIfBackedUp: true,
      onMessage: args => this.#message(live, args),
    };

    let [error] = this.#realtime.registerChannel(options);
    if(error?.code === 409){
      // Left over from a session that was never ended, on this same process
      this.#realtime.unregisterChannel({ channel: live.channel });
      [error] = this.#realtime.registerChannel(options);
    }
    return error ? { code: 500, msg: 'Could not open the game\'s channel' } : null;
  };

  /*
    Presence, reported by core's realtime hooks. A connection counts once it has subscribed to the
    game's channel, so a player with the page open but no live connection is not "online".
  */

  connected = async ({ channel, userId, connectionId }) => {
    const live = this.#channels.get(channel);
    if(!live || live.runtime.ending) return;

    this.#clearIdle(live);
    const removal = live.runtime.removal.get(userId);
    if(removal){
      this.#timers.clearTimeout(removal);
      live.runtime.removal.delete(userId);
    }

    const { first } = await live.connect(userId, connectionId);
    if(first && live.type.tickRate > 0 && !live.runtime.tick) this.#startTick(live);
  };

  disconnected = async ({ channel, userId, connectionId }) => {
    const live = this.#channels.get(channel);
    if(!live || live.runtime.ending) return;

    const { last } = await live.disconnect(userId, connectionId);
    if(!last) return;

    const member = live.member(userId);
    if(member && member.role !== 'owner' && live.type.removeAfterSeconds > 0){
      const timer = this.#timers.setTimeout(() => this.#removeAbsent(live, userId), live.type.removeAfterSeconds * 1000);
      timer?.unref?.();
      live.runtime.removal.set(userId, timer);
    }

    if(live.onlineCount === 0){
      this.#stopTick(live);
      this.#startIdle(live);
    }
  };

  #removeAbsent = async (live, userId) => {
    live.runtime.removal.delete(userId);
    const member = live.member(userId);
    if(!member || member.connections.size || member.role === 'owner') return;

    await deletePlayer(live.id, userId);
    await this.#notify('game:player_left', { gameId: live.id, userId, reason: 'absent' });
    await this.refresh(live.id);
  };

  /*
    Messages from players
  */

  #message = async (live, { user, data, connectionId }) => {
    if(live.runtime.ending) throw { code: 409, msg: 'This game is closing' };
    if(!live.isMember(user.id)) throw { code: 403, msg: 'You are not a player in this game' };

    const type = data && typeof data === 'object' ? data.t : undefined;

    if(type === 'input') return live.input({ userId: user.id, input: data.input });
    if(type === 'sync') return live.snapshot(user.id);

    if(type === 'save'){
      const member = live.member(user.id);
      if(member.role !== 'owner' && !live.type.allowPlayerSave) throw { code: 403, msg: 'Only the owner can save this game' };
      const [error, result] = await this.save(live, { reason: 'requested', actorId: user.id });
      if(error) throw error;
      return result;
    }

    throw { code: 400, msg: 'Unknown message' };
  };

  /*
    Ticks
  */

  #startTick = (live) => {
    live.runtime.lastTick = this.#now();
    live.runtime.tick = this.#timers.setInterval(() => this.#tick(live), 1000 / live.type.tickRate);
    live.runtime.tick?.unref?.();
  };

  #stopTick = (live) => {
    if(!live.runtime.tick) return;
    this.#timers.clearInterval(live.runtime.tick);
    live.runtime.tick = null;
  };

  #tick = async (live) => {
    const runtime = live.runtime;
    if(runtime.ticking || runtime.ending) return;
    runtime.ticking = true;

    const now = this.#now();
    const dt = (now - runtime.lastTick) / 1000;
    runtime.lastTick = now;

    try {
      await live.tick(dt);
      runtime.tickErrors = 0;
    } catch(error) {
      runtime.tickErrors++;
      this.#log.error(`[kempo-game] ${live.type.id} onTick threw for game ${live.id}: ${error?.message || error}`);
      if(runtime.tickErrors >= MAX_TICK_ERRORS){
        this.#log.error(`[kempo-game] ending game ${live.id}: onTick failed ${MAX_TICK_ERRORS} times in a row`);
        this.end(live, { reason: 'error' });
      }
    } finally {
      runtime.ticking = false;
    }
  };

  /*
    Idle. A live game nobody is connected to is ended after a grace period, so a page refresh does not
    end a game but an abandoned one does not stay in memory for ever. 0 means never end on its own.
  */

  #startIdle = (live) => {
    this.#clearIdle(live);
    const seconds = live.type.idleSeconds ?? live.runtime.config.idleSeconds;
    if(seconds <= 0) return;
    live.runtime.idle = this.#timers.setTimeout(() => this.end(live, { reason: 'idle' }), seconds * 1000);
    live.runtime.idle?.unref?.();
  };

  #clearIdle = (live) => {
    if(!live.runtime.idle) return;
    this.#timers.clearTimeout(live.runtime.idle);
    live.runtime.idle = null;
  };

  /*
    Saving

    Serialized per game: two saves at once would both read the same version and one would be refused for a
    conflict that was really this process racing itself.
  */

  save = (live, { reason = 'manual', actorId } = {}) => {
    const run = live.runtime.saving.then(() => this.#save(live, reason, actorId));
    live.runtime.saving = run.catch(() => {});
    return run;
  };

  #autosave = async (live) => {
    if(!live.dirty || live.runtime.ending) return;
    const [error] = await this.save(live, { reason: 'autosave' });
    if(error) this.#log.error(`[kempo-game] autosave of ${live.id} failed: ${error.msg}`);
  };

  #save = async (live, reason, actorId) => {
    if(live.runtime.ended) return [{ code: 409, msg: 'This game has ended' }, null];

    try {
      await this.#hook('game:before_save', { gameId: live.id, type: live.type.id, reason, actorId: actorId || null }, { bail: true });
    } catch(error) {
      return [asError(error, { code: 403, msg: 'This game cannot be saved right now' }), null];
    }

    const payload = live.savePayload();
    const save = { state: payload.state };
    await live.run('onSave', { session: live.api, save });

    const size = Buffer.byteLength(JSON.stringify(save.state));
    if(size > live.runtime.config.maxStateBytes){
      return [{ code: 413, msg: `The game's state is ${size} bytes, over the ${live.runtime.config.maxStateBytes} byte limit` }, null];
    }

    let version;
    try {
      version = await saveState({ gameId: live.id, state: save.state, expectedVersion: live.stateVersion, players: payload.players });
    } catch(error) {
      this.#log.error(`[kempo-game] saving ${live.id} failed: ${error.message}`);
      return [{ code: 500, msg: 'The game could not be saved' }, null];
    }

    if(version === null){
      this.#log.error(`[kempo-game] ${live.id} was saved by someone else since this process loaded it; ending the session here`);
      this.end(live, { reason: 'stale', save: false });
      return [{ code: 409, msg: 'This game was changed elsewhere; rejoin it to continue' }, null];
    }

    live.markSaved({ revision: payload.revision, stateVersion: version });
    await this.#notify('game:saved', { gameId: live.id, type: live.type.id, version, reason });
    return [null, { version, savedAt: new Date().toISOString() }];
  };

  /*
    Ending
  */

  end = (live, { reason = 'ended', save = true } = {}) => {
    const runtime = live.runtime;
    if(runtime.ending) return runtime.ending;

    runtime.ending = (async () => {
      this.#stopTick(live);
      this.#clearIdle(live);
      if(runtime.autosave) this.#timers.clearInterval(runtime.autosave);
      runtime.autosave = null;
      for(const timer of runtime.removal.values()) this.#timers.clearTimeout(timer);
      runtime.removal.clear();

      if(save && live.dirty){
        const [error] = await this.save(live, { reason: 'end' });
        if(error) this.#log.error(`[kempo-game] the final save of ${live.id} failed: ${error.msg}`);
      }

      await live.run('onEnd', { session: live.api });

      runtime.ended = true;
      this.#realtime.unregisterChannel({ channel: live.channel });
      this.#games.delete(live.id);
      this.#channels.delete(live.channel);

      await this.#notify('game:ended', { gameId: live.id, type: live.type.id, reason });
    })();

    return runtime.ending;
  };

  shutdown = async () => {
    await Promise.all(this.list().map(live => this.end(live, { reason: 'shutdown' })));
  };

  /*
    The database changed under a running game
  */

  refresh = async (gameId) => {
    const live = this.#games.get(gameId);
    if(!live || live.runtime.ending) return;

    const row = await findGame(gameId);
    if(!row) return;

    const players = (await findPlayers(gameId)).filter(player => player.status === 'joined');
    const names = await findUserNames(players.map(player => player.userId));
    const dropped = live.syncMembers(
      players.map(player => ({ userId: player.userId, name: names.get(player.userId) || 'Player', role: player.role, data: player.data })),
      row.ownerId,
    );

    for(const { connections } of dropped){
      for(const connectionId of connections) this.#realtime.closeConnection({ connectionId, code: 1000, reason: 'You are no longer in this game' });
    }
  };

  settingsChanged = (gameId, settings, name) => {
    const live = this.#games.get(gameId);
    if(!live) return;
    live.setSettings(settings);
    if(name) live.name = name;
    this.#publish(live.channel, { game: live.id, t: 'settings', settings, name: live.name });
  };

  /*
    Internals
  */

  #publish = (channel, data) => {
    const previous = this.#chains.get(channel) || Promise.resolve();
    const next = previous
      .then(async () => {
        const [error] = await this.#realtime.publish({ channel, data });
        // A 404 is the game ending while a last patch was still in flight
        if(error && error.code !== 404) this.#log.error(`[kempo-game] could not publish to ${channel}: ${error.msg}`);
      })
      .catch(() => {});
    this.#chains.set(channel, next);
    next.then(() => { if(this.#chains.get(channel) === next) this.#chains.delete(channel); });
  };

  #notify = async (event, data) => {
    try {
      await this.#hook(event, data);
    } catch(error) {
      this.#log.error(`[kempo-game] a ${event} hook failed: ${error?.message || error}`);
    }
  };
}
