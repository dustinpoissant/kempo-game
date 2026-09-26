import { spawn } from 'child_process';
import { mkdir, writeFile, rm } from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import {
  databaseReachable, skipped, install, uninstall, makeUser, root,
  expect, until, wait, FIXTURE, PASSWORD, db, kempoGame,
} from './helpers/harness.js';
import { RealtimeClient } from 'kempo/dist/kempo/realtime.js';
import GameConnection from '../public/GameConnection.js';

/*
  How much a single kempo process can carry of this layer, measured rather than assumed.

  Twenty players share a game, and each clicks 20 times a second: the load of a full shared world at the
  size this was designed for. Every click is stamped when it is sent, and every other player's connection
  times how long it takes to hear of it, so what is reported is what a player would feel: from a click to
  the change arriving at everyone else, through the socket, the game's rules, the tick that batches the
  change, the patch and the client applying it.

  It runs that once with a single game and once with ten at the same time, on one process, to answer the
  question of whether a server can host several busy games at once and not only one.

  Read the numbers with the caveats they came with. Everything runs on one machine over loopback, so the
  network contributes nothing and a real player adds their round-trip time to every figure. The clients
  share that machine, and an event loop, with each other and with the measurement. Windows timers tick
  about every 15 ms, so the senders catch up to a schedule rather than trusting setInterval. The bounds
  asserted are generous so a busy machine does not fail the run; the printed figures are the result.

  Needs a reachable Postgres whose name ends in _test, and a current build of kempo.
*/

const CROWD = `${FIXTURE}:crowd`;
const PLAYERS = 20;
const SENDS_PER_SECOND = 20;
const SECONDS = 8;
const state = { server: null, port: 10000 + Math.floor(Math.random() * 20000), dir: path.join(root, 'tests', '.tmp-capacity'), clients: [] };

const base = () => `http://127.0.0.1:${state.port}`;

const startServer = async () => {
  state.server = spawn(process.execPath, [
    path.join(root, 'node_modules', 'kempo-server', 'dist', 'index.js'),
    '--root', path.join(root, 'node_modules', 'kempo', 'app-public'),
    '--config', path.join(state.dir, 'capacity.config.json'),
    '--port', String(state.port),
    '--logging', 'silent',
  ], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, KEMPO_REALTIME_MAX_MESSAGES_PER_SECOND: '10000', KEMPO_REALTIME_MAX_CONNECTIONS_PER_USER: '50' },
  });

  let up = false;
  for(let i = 0; i < 150 && !up; i++){
    up = await fetch(`${base()}/login`).then(() => true).catch(() => wait(200).then(() => false));
  }
  expect(up, 'the server did not start');
};

const api = async (user, method, route, body) => {
  const response = await fetch(`${base()}/game/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `session_token=${user.cookie}` },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  expect(response.ok, `${method} ${route} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const round = value => Math.round(value * 10) / 10;

/*
  One player per user with one socket, subscribed to every game that user is in. That is fewer sockets than
  one per player per game, but the server does the same work per message and per patch.
*/
const measure = async ({ games: gameCount, users }) => {
  const latencies = [];
  const connections = [];
  const gameIds = [];

  for(let g = 0; g < gameCount; g++){
    const { game } = await api(users[0], 'POST', '/games', { type: CROWD, name: `Crowd ${g}` });
    gameIds.push(game.id);
    for(const user of users.slice(1)){
      await api(users[0], 'POST', `/games/${game.id}/invites`, { userId: user.id });
      await api(user, 'POST', `/games/${game.id}/accept`, {});
    }
  }

  for(const user of users){
    for(const gameId of gameIds){
      const opened = await api(user, 'POST', `/games/${gameId}/join`, {});
      const connection = new GameConnection({ realtime: user.realtime, gameId, channel: opened.channel });
      connection.onLive((live, event) => {
        if(!event.changes) return;
        const now = performance.now();
        for(const change of event.changes){
          if(change.length === 2 && change[0][0] === 'stamps' && change[0].length === 2 && change[0][1] !== user.id) latencies.push(now - change[1]);
        }
      });
      connections.push({ user, gameId, connection });
    }
  }
  await Promise.all(connections.map(entry => entry.connection.ready));
  await until(() => connections.every(entry => Object.keys(entry.connection.players).every(id => entry.connection.players[id].online)), 'every player to be online in every game', 15000);

  const before = (await Promise.all(gameIds.map(async id => (await db.select().from(kempoGame).where(eq(kempoGame.id, id)))[0]))).map(row => row.stateVersion);

  let sent = 0;
  let accepted = 0;
  let failed = 0;
  const startedAt = performance.now();
  const timers = connections.map(entry => {
    let seq = 0;
    return setInterval(() => {
      const due = Math.floor((performance.now() - startedAt) / (1000 / SENDS_PER_SECOND)) - seq;
      for(let i = 0; i < due; i++){
        seq++;
        sent++;
        entry.connection.send({ type: 'click', t: performance.now() }).then(() => { accepted++; }, () => { failed++; });
      }
    }, 5);
  });

  await wait(SECONDS * 1000);
  timers.forEach(clearInterval);
  await until(() => accepted + failed === sent, 'every reply to arrive', 15000);
  await wait(1000);

  // Everyone in a game ends up looking at the same thing, and nothing was lost or counted twice
  let scoreTotal = 0;
  for(const gameId of gameIds){
    const views = connections.filter(entry => entry.gameId === gameId).map(entry => entry.connection);
    const first = views[0];
    expect(views.every(view => JSON.stringify(view.live.scores) === JSON.stringify(first.live.scores) && view.v === first.v), `every player in game ${gameId} should hold identical scores and be at the same version`);
    scoreTotal += Object.values(first.live.scores).reduce((sum, value) => sum + value, 0);
  }

  const after = (await Promise.all(gameIds.map(async id => (await db.select().from(kempoGame).where(eq(kempoGame.id, id)))[0]))).map(row => row.stateVersion);

  latencies.sort((a, b) => a - b);
  const report = {
    games: gameCount,
    playersPerGame: PLAYERS,
    seconds: SECONDS,
    achievedClicksPerSecond: Math.round(sent / SECONDS),
    clicksSent: sent,
    clicksAccepted: accepted,
    clicksCounted: scoreTotal,
    observations: latencies.length,
    p50: round(percentile(latencies, 0.5)),
    p95: round(percentile(latencies, 0.95)),
    p99: round(percentile(latencies, 0.99)),
    max: round(latencies.at(-1)),
    databaseWritesDuringRun: after.reduce((sum, version, index) => sum + (version - before[index]), 0),
  };

  for(const entry of connections) entry.connection.close();
  for(const gameId of gameIds) await api(users[0], 'DELETE', `/games/${gameId}`);

  return { report, failed };
};

const suite = () => ({
  'twenty players in a game, then ten games at once: nothing is lost, everyone agrees, the database is untouched and latency stays low': async ({ pass, log }) => {
    const users = [];
    for(let i = 0; i < PLAYERS; i++){
      const user = await makeUser(`cap${i}`);
      const response = await fetch(`${base()}/kempo/api/auth/login/email`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PASSWORD }), redirect: 'manual',
      });
      user.cookie = (response.headers.get('set-cookie') || '').match(/session_token=([^;]+)/)?.[1];
      expect(user.cookie, 'a player could not sign in');

      class CookieSocket extends WebSocket {
        constructor(url){ super(url, { headers: { Cookie: `session_token=${user.cookie}` } }); }
      }
      user.realtime = new RealtimeClient({ url: `ws://127.0.0.1:${state.port}/kempo/api/realtime`, WebSocket: CookieSocket, checkSession: async () => true });
      user.realtime.start();
      state.clients.push(user.realtime);
      users.push(user);
    }

    const runs = [];
    for(const games of [1, 10]){
      const { report, failed } = await measure({ games, users });
      console.log(`\n  capacity: ${JSON.stringify(report)}`);
      log(JSON.stringify(report));
      runs.push(report);

      expect(failed === 0, `${failed} clicks were refused`);
      expect(report.clicksAccepted === report.clicksSent, `every click should be accepted, ${report.clicksSent - report.clicksAccepted} were not (${games} games)`);
      expect(report.clicksCounted === report.clicksAccepted, `every accepted click should be counted exactly once, ${report.clicksAccepted} accepted and ${report.clicksCounted} counted (${games} games)`);
      expect(report.databaseWritesDuringRun === 0, `the fast-changing data must never be written: ${report.databaseWritesDuringRun} writes (${games} games)`);
      // Generous on purpose: a busy machine must not fail the run, and the printed figures are the result
      expect(report.p95 < 500, `95% of changes should reach the other players within 500ms, p95 was ${report.p95}ms (${games} games)`);
      expect(report.p50 < 250, `the median change should reach them within 250ms, p50 was ${report.p50}ms (${games} games)`);
      expect(report.achievedClicksPerSecond >= PLAYERS * games * SENDS_PER_SECOND * 0.9, `the clients could not keep up with the intended rate, ${report.achievedClicksPerSecond} a second (${games} games)`);
      await wait(500);
    }

    pass(runs.map(run => `${run.games} game${run.games === 1 ? '' : 's'}: ${run.achievedClicksPerSecond} clicks/s in, p50 ${run.p50}ms, p95 ${run.p95}ms, p99 ${run.p99}ms, max ${run.max}ms, ${run.databaseWritesDuringRun} writes`).join('; '));
  }
});

export default databaseReachable
  ? {
    'setup: install, and start a real server': async ({ pass }) => {
      await install();
      await mkdir(state.dir, { recursive: true });
      await writeFile(path.join(state.dir, 'capacity.config.json'), JSON.stringify({
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
      if(state.server){
        const exited = new Promise(resolve => state.server.once('exit', resolve));
        state.server.kill('SIGKILL');
        await exited;
      }
      await uninstall();
      await rm(state.dir, { recursive: true, force: true }).catch(() => {});
      pass('removed');
    }
  }
  : skipped('capacity');
