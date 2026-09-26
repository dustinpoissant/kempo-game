import { eq } from 'drizzle-orm';
import { setSetting } from 'kempo/server/sdk.js';
import {
  databaseReachable, skipped, install, uninstall, purgeData, makeUser, installHooks, removeHooks, hookLog,
  expect, until, wait, FIXTURE, db, kempoGame, kempoGamePlayer,
} from './helpers/harness.js';
import { fakeClock, fakeRealtime } from './helpers/fakes.js';
import { createGame, invitePlayer, acceptInvite } from '../sdk.js';
import Manager from '../server/utils/live/Manager.js';
import { applyChanges } from '../public/utils/changes.js';

/*
  A running game, against a real database, with the clock and the realtime layer replaced so a game can be
  driven through half a minute of autosaves in a moment and everything it sends can be read back.

  Each test builds a game, starts it on its own Manager (the way the first player to join does) and then
  plays it by calling what a connection would call: the channel's `authorize` and `onMessage`, and the
  hooks core fires when a connection subscribes or goes away.
*/

const RACE = `${FIXTURE}:click-race`;
const CROWD = `${FIXTURE}:crowd`;
const TURNS = `${FIXTURE}:turns`;
const PLAIN = `${FIXTURE}:plain`;

const ok = ([error, data], what) => {
  expect(error === null, `${what} should succeed, got ${JSON.stringify(error)}`);
  return data;
};

const rows = async (gameId) => (await db.select().from(kempoGame).where(eq(kempoGame.id, gameId)))[0];

const thrown = async (promise) => {
  try {
    await promise;
    return null;
  } catch(error) {
    return error;
  }
};

/*
  Builds a game with `count` players who have all accepted, starts it, and hands back what a test needs.
*/
const boot = async ({ type = RACE, count = 2, settings, extra = {} } = {}) => {
  await purgeData();
  const clock = fakeClock();
  const realtime = fakeRealtime();
  const errors = [];
  const manager = new Manager({ realtime, timers: clock, now: clock.now, log: { error: message => errors.push(message) }, ...extra });

  const users = [];
  for(let i = 0; i < count; i++) users.push(await makeUser(`p${i}`));
  const { game } = ok(await createGame({ ownerId: users[0].id, type, name: 'Test game', settings }), 'creating the game');
  for(const user of users.slice(1)){
    ok(await invitePlayer({ gameId: game.id, userId: user.id, invitedBy: users[0].id }), 'inviting');
    ok(await acceptInvite({ gameId: game.id, userId: user.id }), 'accepting');
  }

  const live = ok(await manager.start(game.id), 'starting the game');
  const channel = live.channel;
  const options = () => realtime.channels.get(channel);

  const play = {
    manager, clock, realtime, errors, users, game, live, channel,
    connect: async (user, connectionId = `c-${user.id}`) => {
      // What core does: authorize on subscribe, then tell hooks the subscription was granted
      const allowed = await options().authorize({ user: { id: user.id }, channel });
      expect(allowed === true, `${user.name} should be allowed to subscribe`);
      await manager.connected({ channel, userId: user.id, connectionId });
      return connectionId;
    },
    disconnect: (user, connectionId = `c-${user.id}`) => manager.disconnected({ channel, userId: user.id, connectionId }),
    send: (user, data, connectionId = `c-${user.id}`) => options().onMessage({ user: { id: user.id, name: user.name }, data, connectionId }),
    click: (user, times = 1) => Promise.all(Array.from({ length: times }, () => play.send(user, { t: 'input', input: { type: 'click' } }))),
    snapshot: user => play.send(user, { t: 'sync' }),
    patches: () => realtime.patches(channel),
    row: () => rows(game.id),
    settle: async () => { await wait(20); },
  };
  return play;
};

const finish = async (play) => {
  await play.manager.shutdown();
  expect(play.errors.length === 0, `the manager logged errors: ${play.errors.join(' | ')}`);
};

const suite = () => ({
  'a game goes live with one process-scoped channel that only its players may join': async ({ pass }) => {
    const play = await boot();
    const options = play.realtime.channels.get(play.channel);
    expect(options.scope === 'process' && options.permission === 'game:play' && options.dropIfBackedUp === true, `unexpected channel options ${JSON.stringify({ ...options, authorize: undefined, onMessage: undefined })}`);
    expect(play.channel === `kempo-game:g-${play.game.id}`, `the channel is named for the game, got ${play.channel}`);

    const stranger = await makeUser('stranger');
    expect(await options.authorize({ user: { id: stranger.id } }) === false, 'someone who is not in the game cannot subscribe');
    expect(await options.authorize({ user: { id: play.users[1].id } }) === true, 'a joined player can');

    // Two people opening it at once must end up in one session
    const [second] = await Promise.all([play.manager.start(play.game.id), play.manager.start(play.game.id)]);
    expect(second[1] === play.live && play.realtime.channels.size === 1, 'a second start joins the session that exists');

    await finish(play);
    expect(play.realtime.removed.includes(play.channel) && !play.realtime.channels.has(play.channel), 'ending the game removes its channel');
    pass('channel');
  },

  'concurrent starts of a game that is not live yet still make one session and one channel': async ({ pass }) => {
    const play = await boot();
    await play.manager.end(play.live, { reason: 'test' });
    const results = await Promise.all([play.manager.start(play.game.id), play.manager.start(play.game.id), play.manager.start(play.game.id)]);
    expect(results.every(([error, live]) => error === null && live === results[0][1]), 'all three get the same session');
    expect(play.realtime.channels.size === 1, `one channel, got ${play.realtime.channels.size}`);
    await finish(play);
    pass('start dedupe');
  },

  'starting a game that is missing, or whose type is gone, or whose rules will not load, says why': async ({ pass }) => {
    const play = await boot();
    expect((await play.manager.start('no-such-game'))[0].code === 404, 'a missing game is a 404');

    await db.update(kempoGame).set({ type: 'uninstalled-game:thing' }).where(eq(kempoGame.id, play.game.id));
    await play.manager.end(play.live, { reason: 'test', save: false });
    const [typeError] = await play.manager.start(play.game.id);
    expect(typeError?.code === 409 && /not installed/.test(typeError.msg), `a game whose type is gone is a 409, got ${JSON.stringify(typeError)}`);
    expect(play.realtime.channels.size === 0, 'and opens nothing');
    await finish(play);
    pass('start failures');
  },

  'joining sends a snapshot, and the players and their presence are part of it': async ({ pass }) => {
    const play = await boot();
    const [ann, bob] = play.users;
    await play.connect(ann);

    const snapshot = await play.snapshot(ann);
    expect(snapshot.game === play.game.id && snapshot.you === ann.id, 'a snapshot says which game and who is asking');
    expect(snapshot.info.name === 'Test game' && snapshot.info.type === RACE && snapshot.info.maxPlayers === 2, 'and the game\'s details');
    expect(snapshot.state.status === 'racing' && snapshot.state.target === 100, 'the state is what was saved');
    expect(Object.keys(snapshot.players).length === 2, 'both players are listed');
    expect(snapshot.players[ann.id].online === true && snapshot.players[bob.id].online === false, 'presence: ann is connected, bob is not');
    expect(snapshot.players[ann.id].role === 'owner' && snapshot.players[bob.id].role === 'player', 'roles are shown');
    expect(snapshot.live.scores[ann.id] === 0 && snapshot.live.connects === 1, `the game's own onLoad and onConnect ran, got ${JSON.stringify(snapshot.live)}`);
    expect(!JSON.stringify(snapshot).includes(ann.email), 'no email address is ever sent to other players');

    await finish(play);
    pass('snapshot');
  },

  'someone who is not in the game can neither read it nor act in it': async ({ pass }) => {
    const play = await boot();
    const stranger = await makeUser('stranger');

    for(const data of [{ t: 'sync' }, { t: 'input', input: { type: 'click' } }, { t: 'save' }]){
      const error = await thrown(play.send(stranger, data));
      expect(error?.code === 403, `${data.t} from a stranger should be a 403, got ${JSON.stringify(error)}`);
    }
    expect(play.patches().length === 0, 'and nothing changed');
    await finish(play);
    pass('membership');
  },

  'input goes to the rules, an unknown message is refused, and the rules can refuse on purpose': async ({ pass }) => {
    const play = await boot();
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);

    const reply = await play.send(ann, { t: 'input', input: { type: 'click' } });
    expect(reply.result.score === 1, `the reply is what the rules returned, got ${JSON.stringify(reply)}`);

    const refusal = await thrown(play.send(ann, { t: 'input', input: { type: 'refuse' } }));
    expect(refusal?.code === 418 && refusal.msg === 'No', 'the rules refuse with their own code and message');
    expect((await thrown(play.send(ann, { t: 'dance' })))?.code === 400, 'an unknown message type is a 400');
    expect((await thrown(play.send(ann, null)))?.code === 400, 'so is no message at all');

    await finish(play);
    pass('input');
  },

  'a game with a minimum waits for its players before it takes input': async ({ pass }) => {
    await purgeData();
    const clock = fakeClock();
    const realtime = fakeRealtime();
    const manager = new Manager({ realtime, timers: clock, now: clock.now });
    const ann = await makeUser('ann');
    const { game } = ok(await createGame({ ownerId: ann.id, type: RACE, name: 'Lonely' }), 'creating');
    const live = ok(await manager.start(game.id), 'starting');

    const error = await thrown(realtime.channels.get(live.channel).onMessage({ user: { id: ann.id }, data: { t: 'input', input: { type: 'click' } }, connectionId: 'c' }));
    expect(error?.code === 409 && /Waiting for more players \(1 of 2\)/.test(error.msg), `expected a wait, got ${JSON.stringify(error)}`);
    await manager.shutdown();
    pass('minimum players');
  },

  'many inputs in one tick go out as one patch, and only when the tick comes': async ({ pass }) => {
    const play = await boot();
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);
    await play.clock.advance(50);
    const before = play.patches().length;

    await play.click(ann, 10);
    await play.click(bob, 4);
    expect(play.patches().length === before, 'nothing is published until the tick');

    await play.clock.advance(50);
    const patches = play.patches().slice(before);
    expect(patches.length === 1, `ten inputs in a tick are one patch, got ${patches.length}`);
    expect(patches[0].live.length === 2 || patches[0].live.length === 1, 'the patch is a change list');
    const merged = applyChanges({ scores: {} }, patches[0].live);
    expect(merged.scores[ann.id] === 10 && merged.scores[bob.id] === 4, `it carries the final scores, got ${JSON.stringify(merged)}`);
    expect(patches[0].state === undefined && patches[0].players === undefined, 'and only what changed');

    await play.clock.advance(500);
    expect(play.patches().length === before + 1, 'an idle tick publishes nothing');
    await finish(play);
    pass('tick batching');
  },

  'a game with no tick rate publishes as soon as its input is handled': async ({ pass }) => {
    const play = await boot({ type: PLAIN, count: 1 });
    const [ann] = play.users;
    await play.connect(ann);
    const before = play.patches().length;

    await play.send(ann, { t: 'input', input: { type: 'note', text: 'hello' } });
    await play.settle();
    const patches = play.patches().slice(before);
    expect(patches.length === 1 && patches[0].state[0][0][0] === 'note' && patches[0].state[0][1] === 'hello', `expected the note at once, got ${JSON.stringify(patches)}`);
    expect(play.clock.count() < 5, 'with no tick timer running');
    await finish(play);
    pass('no tick');
  },

  'a client that applies every patch to its snapshot always ends up identical to the server': async ({ pass }) => {
    const play = await boot({ type: CROWD, count: 6 });
    const clients = play.users;
    for(const user of clients) await play.connect(user);

    const mirror = await play.snapshot(clients[0]);
    let { state, live, players, v } = mirror;
    let cursor = play.patches().length;

    const take = () => {
      for(const patch of play.patches().slice(cursor)){
        if(patch.v <= v) continue;
        expect(patch.v === v + 1, `patch versions must be contiguous, saw ${patch.v} after ${v}`);
        v = patch.v;
        if(patch.state) state = applyChanges(state, patch.state);
        if(patch.live) live = applyChanges(live, patch.live);
        if(patch.players) players = applyChanges(players, patch.players);
      }
      cursor = play.patches().length;
    };

    for(let round = 0; round < 25; round++){
      for(const user of clients) await play.click(user, 1 + (round % 3));
      if(round % 7 === 3) await play.send(clients[round % clients.length], { t: 'input', input: { type: 'note', text: 'round ' + round } });
      if(round === 12) await play.disconnect(clients[5]);
      if(round === 15) await play.connect(clients[5]);
      await play.clock.advance(50);
      take();
    }

    const server = await play.snapshot(clients[0]);
    take();
    expect(JSON.stringify(state) === JSON.stringify(server.state), 'state converges');
    expect(JSON.stringify(live.scores) === JSON.stringify(server.live.scores) && live.connects === server.live.connects, 'live converges');
    expect(JSON.stringify(players) === JSON.stringify(server.players), 'the roster converges, presence included');
    expect(v === server.v, 'and it is at the same version');
    await finish(play);
    pass('convergence');
  },

  'the fast-changing data is never written to the database, and an idle game is not saved': async ({ pass }) => {
    const play = await boot({ settings: { target: 1000000 } });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);
    const before = await play.row();
    expect(before.stateVersion === 0 && before.savedAt === null, 'a new game has never been saved');

    for(let second = 0; second < 6; second++){
      await play.click(ann, 20);
      await play.click(bob, 20);
      await play.clock.advance(1000);
    }
    await play.settle();

    const after = await play.row();
    expect(after.stateVersion === 0 && after.savedAt === null, `six seconds of clicking across three autosave intervals wrote nothing (version ${after.stateVersion})`);
    expect(JSON.stringify(after.state) === JSON.stringify(before.state), 'the stored state is untouched');
    expect(play.patches().length > 0, 'though the players certainly saw it change');
    await finish(play);
    pass('live not saved');
  },

  'a change to the saved state is written on the next autosave, once, and not again until it changes again': async ({ pass }) => {
    const play = await boot({ type: RACE });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);

    await play.send(ann, { t: 'input', input: { type: 'note', text: 'first' } });
    await play.clock.advance(1900);
    await play.settle();
    expect((await play.row()).stateVersion === 0, 'not saved before the interval');

    await play.clock.advance(200);
    await until(async () => (await play.row()).stateVersion === 1, 'the autosave');
    const saved = await play.row();
    expect(saved.state.note === 'first' && saved.savedAt !== null, 'the state was written');

    await play.clock.advance(6000);
    await play.settle();
    expect((await play.row()).stateVersion === 1, 'three more intervals with nothing changed write nothing');

    await play.send(ann, { t: 'input', input: { type: 'note', text: 'second' } });
    await play.clock.advance(2100);
    await until(async () => (await play.row()).stateVersion === 2, 'the next autosave');
    expect((await play.row()).state.note === 'second', 'and it saved the change');
    await finish(play);
    pass('autosave');
  },

  'a type with no timings of its own is saved every thirty seconds, per the site setting': async ({ pass }) => {
    const play = await boot({ type: PLAIN, count: 1 });
    const [ann] = play.users;
    await play.connect(ann);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'kept' } });

    await play.clock.advance(29000);
    await play.settle();
    expect((await play.row()).stateVersion === 0, 'nothing at 29 seconds');
    await play.clock.advance(1100);
    await until(async () => (await play.row()).stateVersion === 1, 'the save at 30 seconds');
    await finish(play);

    await setSetting('kempo-game', 'autosave_seconds', '5', 'number');
    try {
      const other = await boot({ type: PLAIN, count: 1 });
      await other.connect(other.users[0]);
      await other.send(other.users[0], { t: 'input', input: { type: 'note', text: 'faster' } });
      await other.clock.advance(4900);
      await other.settle();
      expect((await other.row()).stateVersion === 0, 'a site that set five seconds is not saved at 4.9');
      await other.clock.advance(200);
      await until(async () => (await other.row()).stateVersion === 1, 'the save at 5 seconds');
      await finish(other);
    } finally {
      await setSetting('kempo-game', 'autosave_seconds', '30', 'number');
    }
    pass('default interval');
  },

  'a type that turns autosave off is saved only when asked, and only by who may ask': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 2 });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'manual' } });

    await play.clock.advance(3600000);
    await play.settle();
    expect((await play.row()).stateVersion === 0, 'an hour passes and nothing is saved');

    const reply = await play.send(bob, { t: 'save' });
    expect(reply.version === 1 && (await play.row()).state.note === 'manual', 'this type lets any player save, and the save is the current state');
    await finish(play);

    const strict = await boot({ type: RACE });
    await strict.connect(strict.users[0]);
    await strict.connect(strict.users[1]);
    const refusal = await thrown(strict.send(strict.users[1], { t: 'save' }));
    expect(refusal?.code === 403, `a player may not save a game whose type says only the owner may, got ${JSON.stringify(refusal)}`);
    const owner = await strict.send(strict.users[0], { t: 'save' });
    expect(owner.version === 1, 'the owner may');
    await finish(strict);
    pass('manual save');
  },

  'a game may fold its fast-changing data into what is saved, and a save is one moment': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 2 });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'x' } });
    play.live.api.state.keepScores = true;
    await play.click(ann, 3).catch(() => {});

    play.live.api.live.scores[ann.id] = 7;
    play.live.api.player(bob.id).data.level = 4;
    await play.send(ann, { t: 'save' });

    const saved = await play.row();
    expect(saved.state.savedScores && saved.state.savedScores[ann.id] === 7, `onSave should have folded the scores in, got ${JSON.stringify(saved.state)}`);
    const bobRow = (await db.select().from(kempoGamePlayer).where(eq(kempoGamePlayer.userId, bob.id)))[0];
    expect(bobRow.data.level === 4, 'a player\'s own data is saved in the same save');
    await finish(play);
    pass('onSave');
  },

  'a save over the size limit is refused and leaves what was saved alone': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 1 });
    const [ann] = play.users;
    await play.connect(ann);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'small' } });
    await play.send(ann, { t: 'save' });

    await setSetting('kempo-game', 'max_state_bytes', '100', 'number');
    try {
      const big = await boot({ type: TURNS, count: 1 });
      await big.connect(big.users[0]);
      await big.send(big.users[0], { t: 'input', input: { type: 'note', text: 'x'.repeat(500) } });
      const error = await thrown(big.send(big.users[0], { t: 'save' }));
      expect(error?.code === 413, `expected a 413, got ${JSON.stringify(error)}`);
      expect((await big.row()).stateVersion === 0 && !(await big.row()).state.note, 'nothing was written');
      expect(big.live.dirty, 'and it is still dirty, so nothing is lost by the refusal');
      await big.manager.shutdown();
      expect(big.errors.length === 1 && /final save/.test(big.errors[0]) && /over the 100 byte limit/.test(big.errors[0]), `ending a game whose state is too big to save says so in the log, got ${JSON.stringify(big.errors)}`);
    } finally {
      await setSetting('kempo-game', 'max_state_bytes', '5000000', 'number');
    }
    await finish(play);
    pass('size limit');
  },

  'a save refused by a guard hook is not written, and one that another server got to first ends this session': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 1 });
    const [ann] = play.users;
    await play.connect(ann);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'guarded' } });

    // Another process saved this game since it was loaded
    await db.update(kempoGame).set({ stateVersion: 5 }).where(eq(kempoGame.id, play.game.id));
    const error = await thrown(play.send(ann, { t: 'save' }));
    expect(error?.code === 409, `a stale save should be a 409, got ${JSON.stringify(error)}`);
    expect(!play.realtime.channels.has(play.channel) && !play.manager.get(play.game.id), 'the session ended, so its players rejoin against the current state');
    expect((await play.row()).state.note === undefined && (await play.row()).stateVersion === 5, 'and nothing of this session was written over the other one');
    await play.settle();
    play.errors.length = 0;
    pass('stale save');
  },

  'the last player leaving saves the game, ends it after the grace period, and a return in time cancels that': async ({ pass }) => {
    const play = await boot({ type: RACE });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'before leaving' } });

    await play.disconnect(ann);
    await play.clock.advance(2000);
    expect(play.manager.get(play.game.id), 'one player is still connected, so the game runs');
    await play.disconnect(bob);

    // Back before the three seconds are up
    await play.clock.advance(2000);
    await play.connect(bob);
    await play.clock.advance(5000);
    expect(play.manager.get(play.game.id), 'a player who came back in time keeps the game running');

    await play.disconnect(bob);
    await play.clock.advance(3100);
    await until(() => !play.manager.get(play.game.id), 'the game to end');
    expect((await play.row()).state.note === 'before leaving', 'it was saved on the way out');
    expect(play.realtime.removed.includes(play.channel), 'and its channel closed');
    await finish(play);
    pass('idle end');
  },

  'the tick runs only while someone is connected': async ({ pass }) => {
    const play = await boot({ type: RACE });
    const [ann, bob] = play.users;

    expect(!play.live.runtime.tick, 'no tick timer before anyone is connected');
    await play.connect(ann);
    expect(play.live.runtime.tick, 'connecting starts the tick timer');
    await play.send(ann, { t: 'input', input: { type: 'trackTicks' } });
    await play.clock.advance(1000);
    const ticks = play.live.api.live.ticks;
    expect(ticks >= 18 && ticks <= 21, `about twenty ticks in a second, got ${ticks}`);

    await play.disconnect(ann);
    const after = play.live.api.live.ticks;
    await play.clock.advance(2000);
    expect(play.live.api.live.ticks === after, 'no ticks while nobody is connected');

    await play.connect(bob);
    await play.clock.advance(500);
    expect(play.live.api.live.ticks > after, 'and they resume when someone returns');
    await finish(play);
    pass('tick lifecycle');
  },

  'presence: a second connection does not double count, and going offline needs the last one to close': async ({ pass }) => {
    const play = await boot({ type: PLAIN, count: 1 });
    const [ann] = play.users;
    await play.connect(ann, 'tab-1');
    await play.connect(ann, 'tab-2');
    expect(play.live.api.live.connects === 1, `onConnect fires for a player's first connection only, got ${play.live.api.live.connects}`);

    await play.disconnect(ann, 'tab-1');
    expect(play.live.api.player(ann.id).online === true, 'still online with a tab open');
    await play.disconnect(ann, 'tab-2');
    expect(play.live.api.player(ann.id).online === false, 'offline once the last closes');
    await play.disconnect(ann, 'tab-3');
    await finish(play);
    pass('presence');
  },

  'a player who stays away past the type\'s limit is removed, unless they return or they own the game': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 3 });
    const [ann, bob, cat] = play.users;
    for(const user of play.users) await play.connect(user);

    await play.disconnect(bob);
    await play.disconnect(cat);
    await play.clock.advance(500);
    await play.connect(bob);
    await play.clock.advance(1500);
    await until(async () => (await db.select().from(kempoGamePlayer).where(eq(kempoGamePlayer.userId, cat.id))).length === 0, 'cat to be removed');
    expect((await db.select().from(kempoGamePlayer).where(eq(kempoGamePlayer.userId, bob.id))).length === 1, 'bob came back in time and stays');
    expect(play.live.isMember(bob.id) && !play.live.isMember(cat.id), 'the running game agrees');

    await play.disconnect(ann);
    await play.clock.advance(5000);
    expect((await db.select().from(kempoGamePlayer).where(eq(kempoGamePlayer.userId, ann.id))).length === 1, 'the owner is never removed for being away');
    await finish(play);
    pass('removal after absence');
  },

  'membership changes reach a running game, and someone removed has their connections closed': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 2 });
    const [ann, bob] = play.users;
    await play.connect(ann);
    await play.connect(bob, 'bob-tab');
    const cat = await makeUser('cat');
    ok(await invitePlayer({ gameId: play.game.id, userId: cat.id, invitedBy: ann.id }), 'inviting');
    ok(await acceptInvite({ gameId: play.game.id, userId: cat.id }), 'accepting');
    await play.manager.refresh(play.game.id);

    const options = play.realtime.channels.get(play.channel);
    expect(await options.authorize({ user: { id: cat.id } }) === true, 'the new player can now subscribe');
    expect(Object.keys((await play.snapshot(ann)).players).length === 3, 'and appears in the roster');

    await db.delete(kempoGamePlayer).where(eq(kempoGamePlayer.userId, bob.id));
    await play.manager.refresh(play.game.id);
    expect(await options.authorize({ user: { id: bob.id } }) === false, 'a removed player cannot subscribe again');
    expect(play.realtime.closed.some(entry => entry.connectionId === 'bob-tab'), 'and their open connection is closed, since a channel only authorizes on subscribe');
    expect(!(bob.id in (await play.snapshot(ann)).players), 'they leave the roster');
    await finish(play);
    pass('refresh');
  },

  'events go to everyone or to one player, and a settings change is announced': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 2 });
    const [ann, bob] = play.users;
    await play.connect(ann, 'ann-tab');
    await play.connect(bob, 'bob-tab');

    await play.send(ann, { t: 'input', input: { type: 'announce', text: 'to all' } });
    await play.settle();
    const announced = play.realtime.published.find(entry => entry.data.t === 'event');
    expect(announced.data.name === 'announcement' && announced.data.data.text === 'to all' && announced.data.game === play.game.id, 'an announcement goes on the channel');

    await play.send(ann, { t: 'input', input: { type: 'whisper', text: 'psst', to: bob.id } });
    expect(play.realtime.direct.length === 1 && play.realtime.direct[0].connectionId === 'bob-tab' && play.realtime.direct[0].data.data.text === 'psst', 'a whisper goes to that player\'s connection only');
    expect(!play.realtime.published.some(entry => entry.data.name === 'whisper'), 'and never on the shared channel');

    play.manager.settingsChanged(play.game.id, { speed: 9 }, 'Renamed');
    await play.settle();
    const settings = play.realtime.published.find(entry => entry.data.t === 'settings');
    expect(settings.data.settings.speed === 9 && settings.data.name === 'Renamed', 'a settings change is published');
    await finish(play);
    pass('events and settings');
  },

  'the lifecycle hooks fire with what an extension needs, and a save guard can refuse': async ({ pass }) => {
    await installHooks(['game:started', 'game:saved', 'game:ended']);
    let play;
    try {
      play = await boot({ type: TURNS, count: 1 });
      const [ann] = play.users;
      await play.connect(ann);
      await play.send(ann, { t: 'input', input: { type: 'note', text: 'hooked' } });
      await play.send(ann, { t: 'save' });
      await play.manager.end(play.live, { reason: 'test' });

      const seen = hookLog();
      expect(seen.map(entry => entry.event).join() === 'game:started,game:saved,game:ended', `unexpected events ${seen.map(entry => entry.event)}`);
      expect(seen[0].gameId === play.game.id && seen[0].type === TURNS, 'started names the game and type');
      expect(seen[1].version === 1 && seen[1].reason === 'requested', 'saved carries the version and why');
      expect(seen[2].reason === 'test', 'ended carries why');
    } finally {
      await removeHooks();
    }
    await finish(play);
    pass('lifecycle hooks');
  },

  'a guard hook can refuse a save with its own message, and the game stays dirty': async ({ pass }) => {
    const play = await boot({ type: TURNS, count: 1 });
    const [ann] = play.users;
    await play.connect(ann);
    await play.send(ann, { t: 'input', input: { type: 'note', text: 'held back' } });

    await installHooks(['game:before_save'], { refuse: play.game.id });
    try {
      const error = await thrown(play.send(ann, { t: 'save' }));
      expect(error?.code === 451 && error.msg === 'Not today', `the hook's own refusal should reach the player, got ${JSON.stringify(error)}`);
      expect((await play.row()).stateVersion === 0, 'nothing was written');
      expect(play.live.dirty, 'and the game is still dirty');
    } finally {
      await removeHooks();
    }

    const saved = await play.send(ann, { t: 'save' });
    expect(saved.version === 1 && (await play.row()).state.note === 'held back', 'once the guard is gone the same save goes through');
    await finish(play);
    pass('save guard');
  }
});

export default databaseReachable
  ? {
    'setup: install kempo-game and the test game': async ({ pass }) => {
      await install();
      pass('installed');
    },
    ...suite(),
    'cleanup: remove everything the suite created': async ({ pass }) => {
      await uninstall();
      pass('removed');
    }
  }
  : skipped('live');
