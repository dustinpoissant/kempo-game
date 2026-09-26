import { spawn } from 'child_process';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import {
  databaseReachable, skipped, install, uninstall, purgeData, makeUser, makeAdmin, root,
  expect, until, wait, FIXTURE, PASSWORD, db, kempoGame,
} from './helpers/harness.js';
import { RealtimeClient } from 'kempo/dist/kempo/realtime.js';
import GameConnection from '../public/GameConnection.js';

/*
  The click race, end to end: a real kempo-server process serving kempo and this extension the way a
  site does, real users signed in with real sessions, and real WebSocket clients running the same
  connection code the browser SDK does.

  Two players each click as fast as they can and the first to the target wins. Their scores change many
  times a second and are never saved; the result is saved once, on the timer. Everything the layer
  promises is checked here from the outside: who may do what, that both players end up looking at
  identical data, that the database is left alone while the race runs, and that a server that restarts
  loses only what was never saved.

  Needs a reachable Postgres whose name ends in _test, with kempo's schema and this extension's applied.
*/

const RACE = `${FIXTURE}:click-race`;
const state = { server: null, port: 10000 + Math.floor(Math.random() * 20000), dir: path.join(root, 'tests', '.tmp-e2e'), clients: [] };

const base = () => `http://127.0.0.1:${state.port}`;

/*
  Server
*/

const startServer = async () => {
  state.server = spawn(process.execPath, [
    path.join(root, 'node_modules', 'kempo-server', 'dist', 'index.js'),
    '--root', path.join(root, 'node_modules', 'kempo', 'app-public'),
    '--config', path.join(state.dir, 'e2e.config.json'),
    '--port', String(state.port),
    '--logging', 'silent',
  ], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, KEMPO_REALTIME_MAX_MESSAGES_PER_SECOND: '2000', KEMPO_REALTIME_MAX_CONNECTIONS_PER_USER: '20' },
  });

  let up = false;
  for(let i = 0; i < 150 && !up; i++){
    up = await fetch(`${base()}/login`).then(() => true).catch(() => wait(200).then(() => false));
  }
  expect(up, 'the server did not start');
};

const stopServer = async () => {
  if(!state.server) return;
  const server = state.server;
  state.server = null;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGKILL');
  await exited;
  await wait(200);
};

/*
  Users and their sessions
*/

const signIn = async (user) => {
  const response = await fetch(`${base()}/kempo/api/auth/login/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
    redirect: 'manual',
  });
  user.cookie = (response.headers.get('set-cookie') || '').match(/session_token=([^;]+)/)?.[1];
  expect(user.cookie, `${user.name} could not sign in`);
  return user;
};

const player = async (label) => signIn(await makeUser(label));

const api = async (user, method, route, body) => {
  const response = await fetch(`${base()}/game/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user?.cookie ? { Cookie: `session_token=${user.cookie}` } : {}) },
    body: body === undefined || method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return response.ok ? [null, data] : [{ code: response.status, msg: data.error }, null];
};

const ok = ([error, data], what) => {
  expect(error === null, `${what} should succeed, got ${JSON.stringify(error)}`);
  return data;
};

const refused = ([error], code, what) => {
  expect(error?.code === code, `${what} should be ${code}, got ${JSON.stringify(error)}`);
  return error;
};

/*
  Clients: the browser's realtime client with the session cookie added, since Node has no cookie jar
*/

const realtimeFor = (user) => {
  class CookieSocket extends WebSocket {
    constructor(url){
      super(url, { headers: { Cookie: `session_token=${user.cookie}` } });
    }
  }
  const client = new RealtimeClient({
    url: `ws://127.0.0.1:${state.port}/kempo/api/realtime`,
    WebSocket: CookieSocket,
    backoff: { base: 50, max: 400 },
    checkSession: async () => true,
  });
  client.start();
  state.clients.push(client);
  return client;
};

const open = async (user, gameId, realtime = realtimeFor(user)) => {
  const opened = ok(await api(user, 'POST', `/games/${gameId}/join`), `${user.name} opening the game`);
  const connection = new GameConnection({
    realtime,
    gameId,
    channel: opened.channel,
    rejoin: async () => {
      const [error, again] = await api(user, 'POST', `/games/${gameId}/join`);
      return error ? null : again.channel;
    },
  });
  await connection.ready;
  return { connection, realtime };
};

/* A created game with both players joined */
const raceOf = async (owner, guest, settings) => {
  const { game } = ok(await api(owner, 'POST', '/games', { type: RACE, name: 'Race', settings }), 'creating');
  ok(await api(owner, 'POST', `/games/${game.id}/invites`, { email: guest.email }), 'inviting');
  ok(await api(guest, 'POST', `/games/${game.id}/accept`, {}), 'accepting');
  return game.id;
};

const row = async (gameId) => (await db.select().from(kempoGame).where(eq(kempoGame.id, gameId)))[0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settled = ([a, b]) => same(a.state, b.state) && same(a.live, b.live) && same(a.players, b.players);

const suite = () => ({
  'the routes turn away the signed out, and anyone without permission to play': async ({ pass }) => {
    const ann = await player('ann');
    const nobody = await signIn(await makeUser('nobody', { player: false }));

    for(const [method, route] of [['GET', '/games'], ['POST', '/games'], ['GET', '/types'], ['GET', '/all'], ['POST', '/games/x/join'], ['DELETE', '/games/x']]){
      refused(await api(undefined, method, route, {}), 401, `${method} ${route} with no session`);
    }
    for(const [method, route] of [['GET', '/games'], ['POST', '/games'], ['GET', '/types'], ['POST', '/games/x/join']]){
      refused(await api(nobody, method, route, { type: RACE, name: 'X' }), 403, `${method} ${route} without game:play`);
    }
    refused(await api(ann, 'GET', '/all'), 403, 'the all-games list for a player who is not an administrator');

    const types = ok(await api(ann, 'GET', '/types'), 'types').types;
    expect(types.some(type => type.id === RACE && type.maxPlayers === 2 && type.label === 'Click race'), 'the declared types are offered');
    expect(types.every(type => !('modulePath' in type) && !('module' in type)), 'and the path to their code is not');
    pass('access');
  },

  'creating, inviting and accepting over HTTP, and who is allowed to see a game': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const cat = await player('cat');

    refused(await api(ann, 'POST', '/games', { type: 'nobody:nothing', name: 'X' }), 400, 'an unknown type');
    const { game } = ok(await api(ann, 'POST', '/games', { type: RACE, name: 'Friday' }), 'creating');
    const gameId = game.id;

    refused(await api(cat, 'GET', `/games/${gameId}`), 404, 'a stranger reading a game');
    refused(await api(bob, 'POST', `/games/${gameId}/invites`, { email: cat.email }), 403, 'a non-member inviting');
    const invited = ok(await api(ann, 'POST', `/games/${gameId}/invites`, { email: bob.email }), 'inviting bob');
    expect(invited.player.status === 'invited', 'invited');

    const bobsList = ok(await api(bob, 'GET', '/games'), 'bob\'s games').games;
    expect(bobsList.length === 1 && bobsList[0].membership.status === 'invited', 'the invitation is in his list');
    const seen = ok(await api(bob, 'GET', `/games/${gameId}`), 'an invitee reading the game');
    expect(seen.membership.status === 'invited' && !('state' in seen.game), 'an invitee can see it, without its state');
    refused(await api(bob, 'POST', `/games/${gameId}/join`, {}), 403, 'an invitee who has not accepted opening it');

    ok(await api(bob, 'POST', `/games/${gameId}/accept`, {}), 'accepting');
    const renamed = ok(await api(ann, 'PATCH', `/games/${gameId}`, { name: 'Saturday' }), 'the owner renaming');
    expect(renamed.game.name === 'Saturday', 'renamed');
    refused(await api(bob, 'PATCH', `/games/${gameId}`, { name: 'Mine' }), 403, 'a player renaming');
    refused(await api(bob, 'DELETE', `/games/${gameId}`), 403, 'a player deleting');
    refused(await api(bob, 'POST', `/games/${gameId}/transfer`, { userId: bob.id }), 403, 'a player transferring');
    refused(await api(ann, 'POST', `/games/${gameId}/leave`, {}), 409, 'the owner leaving');
    ok(await api(bob, 'POST', `/games/${gameId}/leave`, {}), 'a player leaving');
    ok(await api(ann, 'DELETE', `/games/${gameId}`), 'the owner deleting');
    refused(await api(ann, 'GET', `/games/${gameId}`), 404, 'reading it after');
    pass('lifecycle over http');
  },

  'two players race: the first to the target wins, both see the same thing, and the database is left alone until the timer': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);

    const a = (await open(ann, gameId)).connection;
    const b = (await open(bob, gameId)).connection;
    await until(() => a.players[bob.id]?.online && b.players[ann.id]?.online, 'both to be online');
    expect(a.info.type === RACE && a.state.target === 100 && a.live.scores[ann.id] === 0, 'each starts from the same snapshot');
    expect(a.status === 'live' && b.status === 'live', 'and is live');

    const stateBefore = await row(gameId);
    expect(stateBefore.stateVersion === 0 && stateBefore.savedAt === null, 'nothing has been saved');

    // As fast as they can: 130 clicks each, so both would pass the target if the rules let them
    const clicks = (connection) => Promise.allSettled(Array.from({ length: 130 }, () => connection.send({ type: 'click' })));
    const [fromAnn, fromBob] = await Promise.all([clicks(a), clicks(b)]);

    await until(() => a.state.status === 'finished' && b.state.status === 'finished' && settled([a, b]), 'both to see the finish and agree', 8000);

    const winner = a.state.winner;
    const loser = winner === ann.id ? bob.id : ann.id;
    expect([ann.id, bob.id].includes(winner), 'someone won');
    expect(a.live.scores[winner] === 100, `the winner has exactly the target, got ${a.live.scores[winner]}`);
    expect(a.live.scores[loser] < 100, `the loser never reached it, got ${a.live.scores[loser]}`);
    expect(a.live.scores[ann.id] + a.live.scores[bob.id] <= 199, 'no score ever passed the target');
    expect(same(a.state.finalScores, a.live.scores), 'the result records the scores it was decided on');
    expect(same(a, a) && same(a.state, b.state) && same(a.live, b.live) && same(a.players, b.players), 'both players hold identical state, live data and roster');

    // What each player saw of the other's score is what the server holds
    const server = await a.send({ type: 'click' }).catch(error => error);
    expect(server.code === 409 && /over/.test(server.msg), `a click after the win is refused, got ${JSON.stringify(server)}`);
    const accepted = [...fromAnn, ...fromBob].filter(result => result.status === 'fulfilled').length;
    const total = a.live.scores[ann.id] + a.live.scores[bob.id];
    expect(accepted === total, `every accepted click is counted exactly once: ${accepted} accepted, ${total} counted`);

    // The scores were never written. The result is dirty, and waits for the timer
    const during = await row(gameId);
    expect(during.stateVersion === 0 && during.savedAt === null, `the row is untouched while the result waits for the timer, version ${during.stateVersion}`);
    expect(!('scores' in during.state) && !JSON.stringify(during.state).includes('"connects"'), 'and the live data is not in it');

    await until(async () => (await row(gameId)).stateVersion === 1, 'the timed save', 6000);
    const saved = await row(gameId);
    expect(saved.state.winner === winner && saved.state.status === 'finished' && saved.savedAt !== null, 'the result was saved');
    await wait(3500);
    expect((await row(gameId)).stateVersion === 1, 'and only once');
    pass('race');
  },

  'someone outside the game cannot open, subscribe to or act in it': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const stranger = await player('stranger');
    const gameId = await raceOf(ann, bob);
    const { connection } = await open(ann, gameId);

    refused(await api(stranger, 'POST', `/games/${gameId}/join`, {}), 403, 'a stranger opening the game');
    refused(await api(stranger, 'POST', `/games/${gameId}/save`, {}), 403, 'a stranger saving it');

    // Skipping the HTTP layer entirely: subscribe straight to the channel, with a valid session and permission
    const realtime = realtimeFor(stranger);
    const errors = [];
    realtime.subscribe(connection.channel, () => {}, { onError: error => errors.push(error) });
    await until(() => errors.length > 0, 'the subscription to be refused');
    expect(errors[0].code === 403, `a valid player who is not in this game is refused at the channel, got ${JSON.stringify(errors[0])}`);
    const sent = await realtime.send(connection.channel, { t: 'sync' }).catch(error => error);
    expect(sent.code === 403, 'and cannot ask for state either');
    pass('outsiders');
  },

  'what the rules throw reaches the player as they meant it, and nothing else does': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const { connection } = await open(ann, gameId);

    const refusal = await connection.send({ type: 'refuse' }).catch(error => error);
    expect(refusal.code === 418 && refusal.msg === 'No', `the rules' own refusal arrives as given, got ${JSON.stringify(refusal)}`);
    const bug = await connection.send({ type: 'throw' }).catch(error => error);
    expect(bug.code === 500 && !/secret/.test(bug.msg), `a bug in the rules is a generic 500, got ${JSON.stringify(bug)}`);
    const unknown = await connection.send({ type: 'dance' }).catch(error => error);
    expect(unknown.code === 400, 'an input the rules do not know is refused by them');
    pass('errors');
  },

  'announcements reach everyone and whispers reach one player': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const a = (await open(ann, gameId)).connection;
    const b = (await open(bob, gameId)).connection;

    const heardByAnn = [];
    const heardByBob = [];
    a.onEvent((data, event) => heardByAnn.push({ ...data, private: event.private }));
    b.onEvent((data, event) => heardByBob.push({ ...data, private: event.private }));

    await a.send({ type: 'announce', text: 'hello all' });
    await until(() => heardByAnn.length === 1 && heardByBob.length === 1, 'the announcement');
    expect(heardByBob[0].text === 'hello all' && heardByBob[0].private === false, 'everyone hears it');

    await a.send({ type: 'whisper', text: 'psst', to: bob.id });
    await until(() => heardByBob.length === 2, 'the whisper');
    await wait(200);
    expect(heardByBob[1].text === 'psst' && heardByBob[1].private === true, 'bob hears it, as a private one');
    expect(heardByAnn.length === 1, 'and ann does not hear her own whisper');
    pass('events');
  },

  'a player who drops is shown offline to the other and gets a fresh snapshot on return': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const a = (await open(ann, gameId)).connection;
    const bobs = await open(bob, gameId);
    await until(() => a.players[bob.id]?.online === true, 'bob to be online');

    for(let i = 0; i < 7; i++) await bobs.connection.send({ type: 'click' });
    await until(() => a.live.scores[bob.id] === 7, 'ann to see bob\'s score');

    bobs.connection.close();
    bobs.realtime.close();
    await until(() => a.players[bob.id]?.online === false, 'bob to show as offline', 6000);

    const again = await open(bob, gameId);
    expect(again.connection.live.scores[bob.id] === 7, 'a returning player is caught up on everything, including the score they left with');
    await until(() => a.players[bob.id]?.online === true, 'bob to show as online again');
    pass('drop and return');
  },

  'the owner removing a player closes them out of the game': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const a = (await open(ann, gameId)).connection;
    const b = (await open(bob, gameId)).connection;
    const errors = [];
    b.onError(error => errors.push(error));

    ok(await api(ann, 'DELETE', `/games/${gameId}/players/${bob.id}`), 'removing bob');
    await until(() => !a.players[bob.id], 'the roster to drop him');
    await until(() => errors.some(error => error.code === 403), 'bob to be refused when his connection comes back', 8000);
    refused(await api(bob, 'POST', `/games/${gameId}/join`, {}), 403, 'bob opening it again');
    pass('removal');
  },

  'saving on request: the owner may, another player may not, and the save is the current state': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const a = (await open(ann, gameId)).connection;
    const b = (await open(bob, gameId)).connection;

    await a.send({ type: 'note', text: 'saved by request' });
    refused(await api(bob, 'POST', `/games/${gameId}/save`, {}), 403, 'a player saving over HTTP');
    expect((await b.save().catch(error => error)).code === 403, 'or over the connection');
    expect((await row(gameId)).stateVersion === 0, 'so nothing was saved');

    const saved = ok(await api(ann, 'POST', `/games/${gameId}/save`, {}), 'the owner saving');
    expect(saved.version === 1 && (await row(gameId)).state.note === 'saved by request', 'the owner\'s save writes the current state');
    expect((await a.save()).version === 2, 'and over the connection too');
    pass('save on request');
  },

  'an administrator sees every game and can delete any, which ends it for the players in it': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const admin = await signIn(await makeAdmin('admin'));
    const gameId = await raceOf(ann, bob);
    const a = (await open(ann, gameId)).connection;
    let closed = null;
    a.onClosed(event => { closed = event; });

    const all = ok(await api(admin, 'GET', '/all'), 'all games').games;
    const listed = all.find(game => game.id === gameId);
    expect(listed && listed.live === true && listed.playerCount === 2, `the admin list shows it, running, with its players, got ${JSON.stringify(listed)}`);
    ok(await api(admin, 'GET', `/games/${gameId}`), 'an administrator reading a game they are not in');

    ok(await api(admin, 'DELETE', `/games/${gameId}`), 'an administrator deleting it');
    await until(() => closed !== null, 'the player to be told it ended');
    expect(a.status === 'closed', 'their connection is closed');
    expect((await db.select().from(kempoGame).where(eq(kempoGame.id, gameId))).length === 0, 'and the game is gone');
    pass('administrator');
  },

  'a server that restarts loses only what was never saved, and connections carry on by themselves': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const midRace = await raceOf(ann, bob);
    const finished = await raceOf(ann, bob, { target: 5 });

    const a1 = (await open(ann, midRace)).connection;
    const b1 = (await open(bob, midRace)).connection;
    const a2 = (await open(ann, finished)).connection;
    const b2 = (await open(bob, finished)).connection;

    for(let i = 0; i < 30; i++){ await a1.send({ type: 'click' }); await b1.send({ type: 'click' }); }
    await a1.send({ type: 'note', text: 'this was saved' });
    ok(await api(ann, 'POST', `/games/${midRace}/save`, {}), 'saving the note');
    for(let i = 0; i < 5; i++) await a2.send({ type: 'click' });
    await until(() => a2.state.winner === ann.id, 'the short race to finish');
    await until(async () => (await row(finished)).stateVersion === 1, 'its result to be saved', 6000);
    expect(a1.live.scores[ann.id] === 30, 'thirty clicks were counted');

    await stopServer();
    await startServer();

    await until(() => [a1, b1, a2, b2].every(connection => connection.status === 'live' && connection.v >= 0) && a1.live.scores[ann.id] === 0, 'all four connections to recover on their own', 20000);
    expect(a1.live.scores[ann.id] === 0 && b1.live.scores[bob.id] === 0, 'the scores, which were never saved, are back to zero');
    expect(a1.state.note === 'this was saved' && a1.state.status === 'racing', 'what was saved is still there');
    expect(a2.state.winner === ann.id && a2.state.status === 'finished' && b2.state.winner === ann.id, 'a finished race is still finished, with the same winner, for both players');

    // And play carries on, on the new process
    await a1.send({ type: 'click' });
    await until(() => b1.live.scores[ann.id] === 1, 'the other player to see a click after the restart');
    pass('restart');
  },

  'two players opening the same game share one session and one channel': async ({ pass }) => {
    const ann = await player('ann');
    const bob = await player('bob');
    const gameId = await raceOf(ann, bob);
    const first = ok(await api(ann, 'POST', `/games/${gameId}/join`, {}), 'the first open');
    const second = ok(await api(bob, 'POST', `/games/${gameId}/join`, {}), 'the second open');
    expect(first.channel === second.channel, 'two players opening the same game share one session and one channel');
    pass('one session');
  }
});

export default databaseReachable
  ? {
    'setup: install, and start a real server': async ({ pass }) => {
      await install();
      await mkdir(state.dir, { recursive: true });
      await writeFile(path.join(state.dir, 'e2e.config.json'), JSON.stringify({
        customRoutes: { '/kempo/**': '../dist/kempo/**' },
        middleware: { custom: ['../middleware/kempo.js'] },
        templating: { ssr: true, ssrPriority: true, preRender: false },
      }, null, 2));
      await startServer();
      pass('running');
    },
    ...suite(),
    'cleanup: stop the server and remove everything the suite created': async ({ pass }) => {
      for(const client of state.clients.splice(0)) client.close();
      await stopServer();
      await uninstall();
      await rm(state.dir, { recursive: true, force: true }).catch(() => {});
      pass('removed');
    }
  }
  : skipped('click race');
