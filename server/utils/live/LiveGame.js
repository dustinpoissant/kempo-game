import Tracker from './Tracker.js';

/*
  One game while it is running: its state, its fast-changing `live` data, who is in it and who is
  connected, and the module that holds its rules.

  It owns what a game *is* in memory and knows nothing about sockets, timers or the database. Whoever
  runs it (the Manager) hands in `deps`, which is how it publishes a patch or sends to one connection,
  and calls it when something happens. That is what lets it be exercised with no server at all.

  Three documents are kept and synced to every player:

    state    what is saved. Changes make the game dirty, and a dirty game is written on the next save.
    live     what changes many times a second (positions, cursors). Never written by the sync path.
    players  who is in the game: name, role and whether they are online. Managed here, read-only to the game.

  A game's module reads and writes `state` and `live` through `session`, as it would any object. The
  tracker turns those writes into change lists and one batched patch goes out per tick.
*/
export default class LiveGame {
  #deps;
  #state;
  #live;
  #roster;
  #members = new Map();
  #settings;
  #revision = 0;
  #savedRevision = 0;
  #flushQueued = false;

  // Owned by the Manager: its timers and the state of the save and shutdown in progress
  runtime = {};

  constructor({ game, type, module, members, channel, deps }){
    this.id = game.id;
    this.channel = channel;
    this.type = type;
    this.module = module;
    this.name = game.name;
    this.ownerId = game.ownerId;
    this.stateVersion = game.stateVersion;
    this.seq = 0;
    this.#deps = deps;
    this.#settings = game.settings || {};

    const dirty = () => { this.#revision++; };
    const queue = () => this.#queueFlush();

    this.#state = new Tracker(game.state || {}, { onChange: () => { dirty(); queue(); } });
    this.#live = new Tracker({}, { onChange: queue });
    this.#roster = new Tracker({}, { onChange: queue });

    for(const member of members) this.#addMember(member);
    this.#roster.drain();
    this.#revision = 0;
    this.#savedRevision = 0;

    this.api = this.#buildApi();
  }

  /*
    What the game's module sees. Everything on it is either a tracked document or a small function; the
    class itself, its timers and its dependencies are not reachable from here.
  */
  #buildApi = () => {
    const self = this;
    return Object.freeze({
      id: self.id,
      type: self.type.id,
      get name(){ return self.name; },
      get ownerId(){ return self.ownerId; },
      get settings(){ return structuredClone(self.#settings); },
      get state(){ return self.#state.root; },
      get live(){ return self.#live.root; },
      get players(){ return [...self.#members.values()].map(self.#view); },
      player: userId => (self.#members.has(userId) ? self.#view(self.#members.get(userId)) : null),
      setState: value => self.#state.replace(value),
      setLive: value => self.#live.replace(value),
      markDirty: () => { self.#revision++; },
      emit: (name, data, { to } = {}) => self.emit(name, data, { to }),
      save: () => self.#deps.save(self),
    });
  };

  #view = (member) => ({
    id: member.userId,
    name: member.name,
    role: member.role,
    online: member.connections.size > 0,
    data: member.data.root,
  });

  /*
    Members
  */

  get size(){ return this.#members.size; }
  get onlineCount(){ return [...this.#members.values()].filter(member => member.connections.size > 0).length; }
  isMember = userId => this.#members.has(userId);
  member = userId => this.#members.get(userId) || null;
  members = () => [...this.#members.values()];
  connectionsOf = userId => [...(this.#members.get(userId)?.connections || [])];

  #addMember = ({ userId, name, role, data }) => {
    this.#members.set(userId, {
      userId, name, role,
      connections: new Set(),
      data: new Tracker(structuredClone(data || {}), { onChange: () => { this.#revision++; } }),
    });
    this.#roster.root[userId] = { name, role, online: false };
  };

  /*
    Brings the running game in line with the membership table after someone was added, removed or had
    their role changed. Returns the connections of anyone who is no longer in the game, which the caller
    closes, since a channel authorizes on subscribe and would otherwise keep sending them state.
  */
  syncMembers = (rows, ownerId) => {
    const keep = new Set(rows.map(row => row.userId));
    const dropped = [];

    for(const [userId, member] of this.#members){
      if(keep.has(userId)) continue;
      dropped.push({ userId, connections: [...member.connections] });
      this.#members.delete(userId);
      delete this.#roster.root[userId];
    }

    for(const row of rows){
      const existing = this.#members.get(row.userId);
      if(!existing){
        this.#addMember(row);
        continue;
      }
      if(existing.role !== row.role || existing.name !== row.name){
        existing.role = row.role;
        existing.name = row.name;
        this.#roster.root[row.userId].role = row.role;
        this.#roster.root[row.userId].name = row.name;
      }
    }

    this.ownerId = ownerId;
    return dropped;
  };

  /*
    Presence
  */

  connect = async (userId, connectionId) => {
    const member = this.#members.get(userId);
    if(!member) return { first: false };

    const first = member.connections.size === 0;
    member.connections.add(connectionId);
    if(!first) return { first };

    this.#roster.root[userId].online = true;
    await this.#call('onConnect', { session: this.api, player: this.#view(member) });
    return { first };
  };

  disconnect = async (userId, connectionId) => {
    const member = this.#members.get(userId);
    if(!member || !member.connections.delete(connectionId)) return { last: false };

    const last = member.connections.size === 0;
    if(!last) return { last };

    this.#roster.root[userId].online = false;
    await this.#call('onDisconnect', { session: this.api, player: this.#view(member) });
    return { last };
  };

  /*
    Settings
  */

  get settings(){ return this.#settings; }
  setSettings = (settings) => { this.#settings = settings; };

  /*
    Messages from players
  */

  input = async ({ userId, input }) => {
    const member = this.#members.get(userId);
    if(!member) throw { code: 403, msg: 'You are not a player in this game' };
    if(typeof this.module.onInput !== 'function') throw { code: 405, msg: 'This game does not accept input' };
    if(this.#members.size < this.type.minPlayers){
      throw { code: 409, msg: `Waiting for more players (${this.#members.size} of ${this.type.minPlayers})` };
    }

    const result = await this.module.onInput({ session: this.api, player: this.#view(member), input });
    return { v: this.seq, result: result === undefined ? null : result };
  };

  emit = (name, data, { to } = {}) => {
    const frame = { game: this.id, t: 'event', name, data };
    if(to === undefined){
      this.#deps.publish(this.channel, frame);
      return;
    }
    for(const userId of [].concat(to)){
      for(const connectionId of this.connectionsOf(userId)) this.#deps.direct(connectionId, frame);
    }
  };

  /*
    Ticks and patches
  */

  tick = async (dt) => {
    if(typeof this.module.onTick === 'function') await this.module.onTick({ session: this.api, dt });
    this.flush();
  };

  /*
    A game with no tick rate reacts to input alone, so its changes go out as soon as whatever made them
    yields, and are batched only with the other writes of the same step. A game with a tick rate flushes
    once per tick instead, which is what bounds how many patches a busy game produces.
  */
  #queueFlush = () => {
    if(this.type.tickRate > 0 || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => {
      this.#flushQueued = false;
      this.flush();
    });
  };

  flush = () => {
    const patch = { game: this.id, t: 'patch' };
    let any = false;

    for(const [key, tracker] of [['state', this.#state], ['live', this.#live], ['players', this.#roster]]){
      const changes = tracker.drain();
      if(!changes.length) continue;
      patch[key] = changes;
      any = true;
    }
    if(!any) return null;

    patch.v = ++this.seq;
    this.#deps.publish(this.channel, patch);
    return patch;
  };

  /*
    A whole picture of the game at the version it is at. Anything pending is flushed first, so no patch
    can carry a version the snapshot does not already include.
  */
  snapshot = (userId) => {
    this.flush();
    return {
      game: this.id,
      v: this.seq,
      you: userId,
      info: {
        id: this.id,
        type: this.type.id,
        name: this.name,
        ownerId: this.ownerId,
        settings: structuredClone(this.#settings),
        minPlayers: this.type.minPlayers,
        maxPlayers: this.type.maxPlayers,
      },
      state: this.#state.snapshot(),
      live: this.#live.snapshot(),
      players: this.#roster.snapshot(),
    };
  };

  /*
    Saving
  */

  get dirty(){ return this.#revision !== this.#savedRevision; }
  get revision(){ return this.#revision; }

  savePayload = () => ({
    revision: this.#revision,
    state: this.#state.snapshot(),
    players: [...this.#members.values()].map(member => ({ userId: member.userId, data: member.data.snapshot() })),
  });

  markSaved = ({ revision, stateVersion }) => {
    this.#savedRevision = revision;
    this.stateVersion = stateVersion;
  };

  /*
    A game's module is somebody else's code. An error in a callback is theirs to fix, and it must not stop
    the game or take other players' connections down with it.
  */
  #call = async (name, argument) => {
    if(typeof this.module[name] !== 'function') return;
    try {
      await this.module[name](argument);
    } catch(error) {
      this.#deps.log.error(`[kempo-game] ${this.type.id} ${name} threw for game ${this.id}: ${error?.message || error}`);
    }
  };

  run = (name, argument) => this.#call(name, argument);
}
