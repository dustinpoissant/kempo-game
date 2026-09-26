import GameConnection from '../public/GameConnection.js';

/*
  The browser's connection to a game, driven through a fake realtime client so every way the network can
  misbehave can be produced exactly: a patch that never arrives, one that arrives twice, a snapshot that
  is slow, a server that restarted. None of this needs a database or a server.
*/

const expect = (condition, message) => {
  if(!condition) throw new Error(message);
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const until = async (condition, description, timeout = 1000) => {
  const deadline = Date.now() + timeout;
  while(Date.now() < deadline){
    if(condition()) return;
    await wait(2);
  }
  throw new Error(`timed out waiting for ${description}`);
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const GAME = 'game-1';
const CHANNEL = 'kempo-game:g-game-1';

const snapshot = (overrides = {}) => ({
  game: GAME, v: 0, you: 'ann',
  info: { id: GAME, type: 'x:y', name: 'Test', ownerId: 'ann', settings: {}, minPlayers: 1, maxPlayers: 2 },
  state: { board: [], turn: 'X' },
  live: { scores: { ann: 0 } },
  players: { ann: { name: 'Ann', role: 'owner', online: true } },
  ...overrides,
});

const patch = (v, parts) => ({ game: GAME, t: 'patch', v, ...parts });

/*
  A realtime client that records what the connection asks of it and lets the test answer. `sends` holds
  each request with a `reply`/`fail` to settle it whenever the test decides, so a slow snapshot is just a
  reply that has not been given yet.
*/
const fakeRealtime = () => {
  const subscriptions = [];
  const sends = [];
  const direct = new Set();

  return {
    subscriptions, sends,
    subscribe: (channel, handler, options) => {
      const entry = { channel, handler, options, stopped: false };
      subscriptions.push(entry);
      return () => { entry.stopped = true; };
    },
    send: (channel, data) => new Promise((resolve, reject) => {
      sends.push({ channel, data, reply: resolve, fail: reject });
    }),
    onDirect: (listener) => {
      direct.add(listener);
      return () => direct.delete(listener);
    },
    // What the test plays as the server
    grant: (index = subscriptions.length - 1) => subscriptions[index].options.onSubscribed({ channel: subscriptions[index].channel }),
    deliver: (data, index = subscriptions.length - 1) => subscriptions[index].handler(data),
    refuse: (error, index = subscriptions.length - 1) => subscriptions[index].options.onError({ channel: subscriptions[index].channel, ...error }),
    whisper: data => { for(const listener of direct) listener(data); },
    syncs: () => sends.filter(entry => entry.data.t === 'sync'),
  };
};

const open = async (options = {}) => {
  const realtime = fakeRealtime();
  const connection = new GameConnection({ realtime, gameId: GAME, channel: CHANNEL, ...options });
  realtime.grant();
  realtime.syncs()[0].reply(snapshot());
  await connection.ready;
  return { connection, realtime };
};

export default {
  'it subscribes, asks for a snapshot once the server grants the subscription, and is ready with it': async ({ pass }) => {
    const realtime = fakeRealtime();
    const connection = new GameConnection({ realtime, gameId: GAME, channel: CHANNEL });
    expect(realtime.subscriptions.length === 1 && realtime.subscriptions[0].channel === CHANNEL, 'it subscribes to the game\'s channel');
    expect(connection.status === 'connecting' && realtime.sends.length === 0, 'and asks for nothing before the subscription is granted, since the server would refuse it');

    realtime.grant();
    expect(realtime.syncs().length === 1 && realtime.syncs()[0].channel === CHANNEL, 'once granted it asks for a snapshot');

    realtime.syncs()[0].reply(snapshot({ v: 4, state: { board: ['X'] } }));
    const ready = await connection.ready;
    expect(ready === connection && connection.status === 'live', 'ready settles with the connection, live');
    expect(connection.v === 4 && connection.userId === 'ann' && connection.info.name === 'Test' && same(connection.state, { board: ['X'] }), 'and it holds what the snapshot said');
    pass('snapshot');
  },

  'patches are applied in order, a repeat is ignored, and listeners hear what changed': async ({ pass }) => {
    const { connection, realtime } = await open();
    const heard = [];
    connection.onState((state, event) => heard.push(['state', event.changes.length]));
    connection.onLive((live, event) => heard.push(['live', event.changes.length]));
    connection.onPlayers((players, event) => heard.push(['players', event.changes.length]));

    realtime.deliver(patch(1, { state: [[['turn'], 'O']], live: [[['scores', 'ann'], 3]] }));
    realtime.deliver(patch(2, { players: [[['ann', 'online'], false]] }));
    expect(connection.v === 2 && connection.state.turn === 'O' && connection.live.scores.ann === 3 && connection.players.ann.online === false, 'each tree is patched');
    expect(same(heard, [['state', 1], ['live', 1], ['players', 1]]), `each listener hears only its own tree, got ${JSON.stringify(heard)}`);

    realtime.deliver(patch(2, { live: [[['scores', 'ann'], 99]] }));
    realtime.deliver(patch(1, { live: [[['scores', 'ann'], 98]] }));
    expect(connection.live.scores.ann === 3 && connection.v === 2, 'a patch already seen changes nothing');
    expect(realtime.syncs().length === 1, 'and does not cause a resync');
    pass('patches');
  },

  'a missing patch is noticed from the version and a fresh snapshot replaces what it holds': async ({ pass }) => {
    const { connection, realtime } = await open();
    realtime.deliver(patch(1, { live: [[['scores', 'ann'], 1]] }));
    realtime.deliver(patch(3, { live: [[['scores', 'ann'], 3]] }));
    expect(connection.live.scores.ann === 1, 'the patch after the gap is not applied on a guess');
    expect(realtime.syncs().length === 2, 'it asks for a snapshot instead');

    realtime.syncs()[1].reply(snapshot({ v: 5, live: { scores: { ann: 5 } } }));
    await until(() => connection.v === 5, 'the snapshot to be applied');
    expect(connection.live.scores.ann === 5, 'and takes it whole');
    realtime.deliver(patch(6, { live: [[['scores', 'ann'], 6]] }));
    expect(connection.live.scores.ann === 6, 'then carries on from its version');
    pass('gap');
  },

  'patches that arrive while a snapshot is on its way are held, and applied after it only if they are newer': async ({ pass }) => {
    const realtime = fakeRealtime();
    const connection = new GameConnection({ realtime, gameId: GAME, channel: CHANNEL });
    realtime.grant();

    // Delivered before the snapshot's reply: two older than it, one the very next after it
    realtime.deliver(patch(4, { live: [[['scores', 'ann'], 4]] }));
    realtime.deliver(patch(5, { live: [[['scores', 'ann'], 5]] }));
    realtime.deliver(patch(6, { live: [[['scores', 'ann'], 6]] }));
    expect(connection.v === -1, 'nothing is applied to a document that has not arrived yet');

    realtime.syncs()[0].reply(snapshot({ v: 5, live: { scores: { ann: 5 } } }));
    await connection.ready;
    expect(connection.v === 6 && connection.live.scores.ann === 6, `the one newer than the snapshot is applied, the older ones dropped, got v ${connection.v}`);
    expect(realtime.syncs().length === 1, 'and no gap was seen');
    pass('held patches');
  },

  'after a reconnect the server confirms again and it fetches a fresh snapshot, replacing everything': async ({ pass }) => {
    const { connection, realtime } = await open();
    realtime.deliver(patch(1, { live: [[['scores', 'ann'], 1]] }));

    realtime.grant();
    expect(realtime.syncs().length === 2, 'a second grant asks again');
    realtime.syncs()[1].reply(snapshot({ v: 0, live: { scores: { ann: 0 } }, state: { board: [], turn: 'X', restarted: true } }));
    await until(() => connection.state.restarted === true, 'the new snapshot');
    expect(connection.v === 0 && connection.live.scores.ann === 0, 'even one at a lower version, as after a server restart');
    pass('resync');
  },

  'a server that restarted no longer has the channel, so it opens the game again and subscribes to the new one': async ({ pass }) => {
    let rejoined = 0;
    const { connection, realtime } = await open({ rejoin: async () => { rejoined++; return 'kempo-game:g-game-1-again'; } });
    const statuses = [];
    connection.onStatus(status => statuses.push(status));

    realtime.refuse({ code: 404, msg: 'Channel does not exist' });
    await until(() => realtime.subscriptions.length === 2, 'a new subscription');
    expect(rejoined === 1 && realtime.subscriptions[0].stopped, 'it asked once, and let go of the old subscription');
    expect(realtime.subscriptions[1].channel === 'kempo-game:g-game-1-again' && connection.channel === 'kempo-game:g-game-1-again', 'and follows the channel it was given');
    expect(statuses.includes('reconnecting'), 'saying so meanwhile');

    realtime.grant();
    realtime.syncs()[1].reply(snapshot({ v: 0 }));
    await until(() => connection.status === 'live', 'to be live again');
    expect(realtime.syncs()[1].channel === 'kempo-game:g-game-1-again', 'and asks for its snapshot on the new channel');
    pass('rejoin');
  },

  'refusals that arrive while it is already opening the game again do not open it twice': async ({ pass }) => {
    let rejoined = 0;
    let finish;
    const { realtime } = await open({ rejoin: () => new Promise((resolve) => { rejoined++; finish = () => resolve('kempo-game:g-game-1-again'); }) });

    realtime.refuse({ code: 404, msg: 'Channel does not exist' });
    realtime.refuse({ code: 404, msg: 'Channel does not exist' });
    realtime.syncs()[0].fail({ code: 404, msg: 'Channel no longer exists' });
    await wait(10);
    expect(rejoined === 1, `it should ask once however many refusals arrive meanwhile, asked ${rejoined} times`);

    finish();
    await until(() => realtime.subscriptions.length === 2, 'the new subscription');
    expect(realtime.subscriptions.length === 2, 'and subscribes once');
    pass('one rejoin at a time');
  },

  'when the game cannot be opened again it reports that instead of looping': async ({ pass }) => {
    let rejoined = 0;
    const { connection, realtime } = await open({ rejoin: async () => { rejoined++; return null; } });
    const errors = [];
    connection.onError(error => errors.push(error));

    realtime.refuse({ code: 404, msg: 'Channel does not exist' });
    await until(() => errors.length === 1, 'the failure to be reported');
    expect(errors[0].code === 404 && rejoined === 1, 'it tried once and reported the original error');
    expect(realtime.subscriptions.length === 1, 'and did not subscribe to anything else');
    pass('rejoin fails');
  },

  'a channel that closes because the game ended is reported as closed': async ({ pass }) => {
    const { connection, realtime } = await open();
    const closed = [];
    connection.onClosed(event => closed.push(event));

    realtime.refuse({ code: 410, msg: 'This channel has closed' });
    expect(connection.status === 'closed' && same(closed, [{ reason: 'ended' }]), 'the game ending closes the connection and says why');
    pass('ended');
  },

  'a refusal before it is ready rejects ready, and a caller that never awaits it sees no unhandled rejection': async ({ pass }) => {
    const realtime = fakeRealtime();
    const connection = new GameConnection({ realtime, gameId: GAME, channel: CHANNEL });
    realtime.refuse({ code: 403, msg: 'Not in this game' });

    let rejected = null;
    try {
      await connection.ready;
    } catch(error) {
      rejected = error;
    }
    expect(rejected?.code === 403, 'ready rejects with the refusal');

    const unwatched = new GameConnection({ realtime: fakeRealtime(), gameId: GAME, channel: CHANNEL });
    unwatched.close();
    pass('refusal');
  },

  'send resolves with what the rules replied and rejects with their refusal': async ({ pass }) => {
    const { connection, realtime } = await open();
    const accepted = connection.send({ type: 'move', cell: 4 });
    const request = realtime.sends.at(-1);
    expect(request.channel === CHANNEL && same(request.data, { t: 'input', input: { type: 'move', cell: 4 } }), 'the input is wrapped for the game');
    request.reply({ v: 3, result: { ok: true } });
    expect(same(await accepted, { ok: true }), 'it resolves with the reply, not the envelope');

    const refused = connection.send({ type: 'move', cell: 4 });
    realtime.sends.at(-1).fail({ code: 409, msg: 'That cell is taken' });
    let error = null;
    try { await refused; } catch(failure) { error = failure; }
    expect(error?.code === 409, 'and rejects with the refusal');

    connection.save();
    expect(same(realtime.sends.at(-1).data, { t: 'save' }), 'save is its own message');
    pass('send');
  },

  'events are heard from the channel and from direct messages, by name if asked, and only for this game': async ({ pass }) => {
    const { connection, realtime } = await open();
    const all = [];
    const named = [];
    connection.onEvent((data, event) => all.push([event.name, event.private]));
    connection.onEvent('hit', data => named.push(data));

    realtime.deliver({ game: GAME, t: 'event', name: 'hit', data: { hp: 3 } });
    realtime.deliver({ game: GAME, t: 'event', name: 'chat', data: { text: 'hi' } });
    realtime.whisper({ game: GAME, t: 'event', name: 'hit', data: { hp: 1 } });
    realtime.whisper({ game: 'other-game', t: 'event', name: 'hit', data: { hp: 9 } });
    realtime.whisper({ t: 'not-a-game-event' });
    realtime.deliver({ game: 'other-game', t: 'event', name: 'hit', data: { hp: 8 } });

    expect(same(all, [['hit', false], ['chat', false], ['hit', true]]), `unexpected events ${JSON.stringify(all)}`);
    expect(same(named, [{ hp: 3 }, { hp: 1 }]), 'a named listener hears only that name');
    pass('events');
  },

  'a settings change updates what it knows about the game, and a listener that throws harms nobody': async ({ pass }) => {
    const { connection, realtime } = await open();
    const heard = [];
    connection.onSettings(settings => heard.push(settings));
    connection.onState(() => { throw new Error('a bug in someone\'s listener'); });
    let after = 0;
    connection.onState(() => { after++; });

    realtime.deliver({ game: GAME, t: 'settings', settings: { speed: 9 }, name: 'Renamed' });
    expect(same(heard, [{ speed: 9 }]) && connection.info.name === 'Renamed' && connection.info.settings.speed === 9, 'settings and name are updated');

    const originalError = console.error;
    console.error = () => {};
    try {
      realtime.deliver(patch(1, { state: [[['turn'], 'O']] }));
    } finally {
      console.error = originalError;
    }
    expect(after === 1 && connection.state.turn === 'O', 'the state was still applied and the next listener still ran');
    pass('settings and listeners');
  },

  'close lets go of the channel and the direct listener, and says closed': async ({ pass }) => {
    const { connection, realtime } = await open();
    const heard = [];
    connection.onEvent(data => heard.push(data));
    connection.close();
    expect(realtime.subscriptions[0].stopped && connection.status === 'closed', 'unsubscribed and closed');
    realtime.whisper({ game: GAME, t: 'event', name: 'x', data: 1 });
    expect(heard.length === 0, 'and it no longer hears direct messages');
    connection.close();
    pass('close');
  }
};
