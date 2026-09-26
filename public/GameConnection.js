import { applyChanges } from './utils/changes.js';

/*
  A player's live connection to one game.

  It keeps three documents identical to the server's (`state`, `live` and `players`), telling you when
  each changes, and sends the player's input. It is built on a realtime client handed to it, which is what
  lets it be exercised in Node against a real server as well as in a browser.

  Staying in step:
    - Subscribing is followed by a request for a snapshot, and again after every reconnect, so a player
      who was offline never has to work out what they missed.
    - Every patch carries a version. One that is exactly the next is applied; one already seen is
      ignored; a gap means a patch was dropped (the channel skips a client that is behind) and asks for
      a fresh snapshot rather than guessing.
    - Patches that arrive while a snapshot is on its way are held and applied after it, if they are newer.
    - A game lives in memory on the server, so a server that restarted no longer has its channel. The
      resubscribe is then refused as unknown, and the connection asks `rejoin` (a function that opens the
      game again and returns its channel) and subscribes to that, so play resumes without the page doing
      anything. It does this once per failure, and gives up if the game cannot be opened.

  `ready` settles once the first snapshot has arrived.
*/
export default class GameConnection {
  #realtime;
  #stopSubscription;
  #stopDirect;
  #syncing = false;
  #held = [];
  #listeners = { state: new Set(), live: new Set(), players: new Set(), event: new Set(), status: new Set(), settings: new Set(), closed: new Set(), error: new Set() };
  #resolveReady;
  #rejectReady;
  #status = 'connecting';
  #rejoin;
  #rejoining = false;

  constructor({ realtime, gameId, channel, rejoin }){
    this.#realtime = realtime;
    this.#rejoin = rejoin;
    this.gameId = gameId;
    this.channel = channel;
    this.v = -1;
    this.info = null;
    this.state = {};
    this.live = {};
    this.players = {};
    this.userId = null;

    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // A caller that never awaits `ready` must not see an unhandled rejection
    this.ready.catch(() => {});

    this.#subscribe();
    this.#stopDirect = realtime.onDirect(data => {
      if(data?.game === this.gameId && data.t === 'event') this.#emit('event', { name: data.name, data: data.data, private: true });
    });
  }

  /*
    Listening. Each returns a function that stops the listener.
  */

  onState = listener => this.#listen('state', listener);
  onLive = listener => this.#listen('live', listener);
  onPlayers = listener => this.#listen('players', listener);
  onSettings = listener => this.#listen('settings', listener);
  onStatus = listener => this.#listen('status', listener);
  onClosed = listener => this.#listen('closed', listener);
  onError = listener => this.#listen('error', listener);

  /*
    Something the game announced with `session.emit`, to everyone or to this player alone. Best effort:
    an event can be skipped for a client that is behind, so anything that must not be lost belongs in
    `state`. Pass a name to hear only that one.
  */
  onEvent = (nameOrListener, maybeListener) => {
    const listener = typeof nameOrListener === 'function' ? nameOrListener : maybeListener;
    const name = typeof nameOrListener === 'function' ? null : nameOrListener;
    return this.#listen('event', event => { if(!name || event.name === name) listener(event.data, event); });
  };

  get status(){ return this.#status; }

  /*
    Acting
  */

  /* Sends input to the game's rules and resolves with what they replied, or rejects with { code, msg } */
  send = async (input, options) => (await this.#realtime.send(this.channel, { t: 'input', input }, options)).result;

  /* Saves the game now. Owner only unless the game type says otherwise */
  save = () => this.#realtime.send(this.channel, { t: 'save' });

  /* Fetches a fresh snapshot; done for you on connect, on reconnect and on a gap */
  resync = () => this.#sync();

  close = () => {
    this.#stopSubscription?.();
    this.#stopDirect?.();
    this.#stopSubscription = null;
    this.#stopDirect = null;
    this.#setStatus('closed');
  };

  /*
    Internals
  */

  #subscribe = () => {
    this.#stopSubscription = this.#realtime.subscribe(this.channel, data => this.#received(data), {
      onSubscribed: () => this.#sync(),
      onError: error => this.#failed(error),
    });
  };

  #listen = (kind, listener) => {
    this.#listeners[kind].add(listener);
    return () => this.#listeners[kind].delete(listener);
  };

  #emit = (kind, ...args) => {
    for(const listener of this.#listeners[kind]){
      try {
        listener(...args);
      } catch(error) {
        console.error(`[kempo-game] a ${kind} listener threw:`, error);
      }
    }
  };

  #setStatus = (status) => {
    if(status === this.#status) return;
    this.#status = status;
    this.#emit('status', status);
  };

  #sync = async () => {
    if(this.#syncing) return;
    this.#syncing = true;
    this.#held = [];

    try {
      const snapshot = await this.#realtime.send(this.channel, { t: 'sync' });
      this.info = snapshot.info;
      this.userId = snapshot.you;
      this.v = snapshot.v;
      this.state = snapshot.state;
      this.live = snapshot.live;
      this.players = snapshot.players;
      this.#syncing = false;

      const held = this.#held.sort((a, b) => a.v - b.v);
      this.#held = [];
      for(const patch of held) this.#apply(patch);

      this.#setStatus('live');
      this.#emit('state', this.state, { snapshot: true });
      this.#emit('live', this.live, { snapshot: true });
      this.#emit('players', this.players, { snapshot: true });
      this.#resolveReady(this);
    } catch(error) {
      this.#syncing = false;
      this.#failed(error);
    }
  };

  #received = (data) => {
    if(!data || data.game !== this.gameId) return;

    if(data.t === 'patch'){
      if(this.#syncing){
        this.#held.push(data);
        return;
      }
      this.#apply(data);
      return;
    }

    if(data.t === 'event'){
      this.#emit('event', { name: data.name, data: data.data, private: false });
      return;
    }

    if(data.t === 'settings'){
      this.info = { ...this.info, settings: data.settings, name: data.name };
      this.#emit('settings', data.settings, this.info);
    }
  };

  #apply = (patch) => {
    if(patch.v <= this.v) return;
    if(patch.v !== this.v + 1){
      this.#sync();
      return;
    }

    this.v = patch.v;
    if(patch.state){
      this.state = applyChanges(this.state, patch.state);
      this.#emit('state', this.state, { changes: patch.state });
    }
    if(patch.live){
      this.live = applyChanges(this.live, patch.live);
      this.#emit('live', this.live, { changes: patch.live });
    }
    if(patch.players){
      this.players = applyChanges(this.players, patch.players);
      this.#emit('players', this.players, { changes: patch.players });
    }
  };

  #failed = async (error) => {
    // The channel is unknown here: the server restarted, or the game went idle and closed. Open it again
    if(error?.code === 404 && this.#rejoin && !this.#rejoining && this.#stopSubscription){
      this.#rejoining = true;
      this.#setStatus('reconnecting');
      try {
        const channel = await this.#rejoin();
        if(channel && this.#stopSubscription){
          this.#stopSubscription();
          this.channel = channel;
          this.#subscribe();
          return;
        }
      } catch(failure) {
        error = failure;
      } finally {
        this.#rejoining = false;
      }
    }

    // 410 is the game ending on the server: it was deleted, or went idle and closed
    if(error?.code === 410){
      this.#setStatus('closed');
      this.#emit('closed', { reason: 'ended' });
      this.#rejectReady(error);
      return;
    }
    this.#emit('error', error);
    this.#rejectReady(error);
  };
}
