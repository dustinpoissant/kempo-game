# kempo-game

A generic multiplayer game layer for [kempo](https://github.com/dustinpoissant/kempo). It is **not a game**. It has no rules, no board and no map. It gives a game, which is its own kempo (CMS) extension, the parts every multiplayer game needs, so the game is only its rules and its screen.

- **Games with players.** A game is a saved record with a name, a type, an owner, settings and state. It can have one player or many; the owner invites people, who accept or decline.
- **Two kinds of data, kept apart on purpose.** `state` is what gets saved. `live` is what changes many times a second, such as positions, and is **never written to the database** on its own.
- **Live sync.** Every player's browser holds the same `state`, `live` data and roster as the server, through one realtime channel per running game.
- **Saving.** On a timer (30 seconds by default, only when something changed), on request, and when the last player leaves.
- **A backend SDK, hooks and a frontend SDK**, plus a lobby element and an admin page.

It is built on kempo's realtime layer (kempo 4.4 or later) and needs nothing else.

## Contents

- [How it fits together](#how-it-fits-together)
- [Install](#install)
- [Writing a game](#writing-a-game)
- [The frontend](#the-frontend)
- [Server SDK](#server-sdk)
- [Hooks](#hooks)
- [Saving](#saving)
- [Settings, permissions and groups](#settings-permissions-and-groups)
- [Running it in production](#running-it-in-production)
- [What it can carry](#what-it-can-carry)
- [Tests](#tests)
- [Not included](#not-included)

## How it fits together

```
 browser                                   server (one kempo process)
 ───────                                   ─────────────────────────
 /game/sdk.js  join(gameId)  ──HTTP──▶     joinGame: the game goes live
 GameConnection              ◀─ channel ─  one process-scoped realtime channel per running game
   state / live / players    ── input ──▶  your game's rules (onInput) change state / live
                             ◀─ patches ─  changes, batched per tick, as small change lists
                                           autosave ─▶ Postgres (state only)
```

A game is **live** from the first time someone opens it until it has been empty for a while, is deleted, or the process stops. While live it lives in memory: its `state` and `live` documents, its players and their connections, a save timer and, if the game has a tick rate, a step timer. A game nobody is in costs nothing, so a site with a thousand saved games and ten people playing runs ten.

The three documents synced to every player:

| Document | What it is | Saved? | Who writes it |
|---|---|---|---|
| `state` | What must survive a restart: the board, the world, progress | Yes, on the timer and on request | Your rules |
| `live` | What changes many times a second: positions, cursors | **Never, unless your game chooses to** | Your rules |
| `players` | Who is in the game: name, role, whether they are online | Membership is; presence is not | kempo-game |

Nothing a client sends changes any of them directly. A client sends an **input**, your rules decide what it means, and the resulting changes go out to everyone.

## Install

```bash
npm install kempo-game
```

Then install it from **Admin, then Extensions**. It creates two tables (`kempoGame`, `kempoGamePlayer`), two permissions, two groups and five settings.

Nobody can play until they hold `game:play`, which the **kempo-game:player** group grants. Add the people who should be able to play to it (or grant the permission from another group, which is how a paid tier would eventually work).

## Writing a game

A game is its own extension. It depends on kempo-game and declares what it is in its `kempo-config.json`:

```json
{
  "dependencies": ["kempo-game"],
  "game": {
    "types": [
      {
        "name": "tic-tac-toe",
        "label": "Tic-tac-toe",
        "module": "./game.js",
        "minPlayers": 2,
        "maxPlayers": 2,
        "tickRate": 0,
        "playUrl": "/tic-tac-toe/play?game={id}"
      }
    ]
  }
}
```

kempo stores that config when the extension is installed, so kempo-game reads it from the database: nothing has to load at startup, and disabling the extension makes its types disappear. A type's id is `<extension>:<name>`. A declaration that cannot be honoured (a bad number, a module path that leaves the package) is left out with a warning rather than half-working.

| Option | Default | |
|---|---|---|
| `name` | | Required |
| `module` | | Required. A path inside your package, starting `./` |
| `label`, `description` | the name | Shown in the lobby |
| `minPlayers`, `maxPlayers` | 1, 1 | Joined players. Input is refused until `minPlayers` have joined; invitations stop at `maxPlayers` |
| `tickRate` | 0 | Steps a second while anyone is connected, up to 60. 0 means the game reacts to input alone |
| `autosaveSeconds` | the site setting | Override how often a changed game is saved. 0 turns it off |
| `idleSeconds` | the site setting | How long an empty running game is kept. 0 keeps it until deleted |
| `removeAfterSeconds` | 0 | Remove a non-owner who has been away this long. 0 never |
| `allowPlayerSave` | false | Let any player save, not only the owner |
| `defaultSettings` | `{}` | Settings a new game starts with |
| `playUrl` | none | Where the lobby's Play button goes; `{id}` is the game's id |

### The rules module

`module` exports the rules. Every function is optional, and it is loaded once and kept in memory, so handling input never touches the database or the disk.

```javascript
// game.js
export const onCreate = ({ settings, ownerId }) => ({ board: Array(9).fill(null), turn: 'X' });

export const onInput = ({ session, player, input }) => {
  if(input.type !== 'move') throw { code: 400, msg: 'Unknown input' };
  if(session.state.board[input.cell]) throw { code: 409, msg: 'That cell is taken' };
  session.state.board[input.cell] = session.state.turn;
  session.state.turn = session.state.turn === 'X' ? 'O' : 'X';
  return { ok: true };
};
```

| Function | Called | Returns |
|---|---|---|
| `onCreate({ settings, ownerId })` | A game is created | The starting `state` (an object) |
| `onLoad({ session })` | The game goes live | Rebuild `live` from `state` here |
| `onConnect({ session, player })` | A player's first connection opens | |
| `onDisconnect({ session, player })` | A player's last connection closes | |
| `onInput({ session, player, input })` | A player sent input | The reply that player receives |
| `onTick({ session, dt })` | Each step, `dt` in seconds. Only for a type with a `tickRate` | |
| `onSave({ session, save })` | Just before a save. Edit `save.state` to fold anything from `live` into what is saved | |
| `onEnd({ session })` | The game stopped being live | |

Refuse an input on purpose by throwing `{ code, msg }`: the sender receives that code and message. Anything else you throw is a bug in your rules; it is logged and the sender receives a generic `500`, never the error's text. An error in a callback never stops the game or takes other players down.

### The session

`session` is what your rules see:

| | |
|---|---|
| `session.state` | The saved document. Write to it as you would any object |
| `session.live` | The fast-changing document, never saved by the sync path |
| `session.players` / `session.player(id)` | `{ id, name, role, online, data }`. `data` is saved per-player data (a level, an inventory) and is not synced; copy what others need into `state` or `live` |
| `session.settings` | A copy of the game's settings |
| `session.setState(value)`, `session.setLive(value)` | Replace a whole document |
| `session.emit(name, data, { to })` | Tell everyone, or the player(s) in `to`. Best effort: an event can be skipped for a client that is behind, so anything that must not be lost belongs in `state` |
| `session.markDirty()` | Say the game should be saved, when what `onSave` will fold in changed without `state` doing so |
| `session.save()` | Save now |
| `session.id`, `session.type`, `session.name`, `session.ownerId` | |

Writes through `session.state` and `session.live` are noticed automatically, and batched into one patch per tick (or as soon as the step that made them ends, for a game with no tick rate). Rules for these documents:

- **JSON only.** Plain objects, arrays, strings, numbers, booleans and `null`.
- **Arrays are sent whole.** Changing one element sends the array, so keep hot data in objects keyed by id rather than in a long array.
- **Write through the document.** A reference you kept to something you assigned into it is not tracked.
- **Assigning an object that is already in the document copies it**, so two places never share one object.

### Two data lanes, and why

A game where players move many times a second must not write each move to the database. Put positions in `live`, and it never is. Put the things that must survive a restart, such as the world, scores and progress, in `state`, and they are saved on the timer. If some of `live` should survive, fold it in from `onSave` and restore it in `onLoad`:

```javascript
export const onSave = ({ session, save }) => { save.state.positions = { ...session.live.positions }; };
export const onLoad = ({ session }) => { session.setLive({ positions: session.state.positions || {} }); };
```

## The frontend

`/game/sdk.js` mirrors the server SDK's names and returns the same `[error, data]` tuples:

```javascript
import { listGames, createGame, invitePlayer, acceptInvite, join } from '/game/sdk.js';

const [error, game] = await join(gameId);   // opens the game and resolves with the first snapshot
game.onState(state => draw(state));
game.onLive(live => drawPlayers(live.players));
game.onPlayers(players => drawRoster(players));
await game.send({ type: 'move', cell: 4 });  // resolves with what your rules returned, or rejects with { code, msg }
```

A connection (`GameConnection`) holds `state`, `live`, `players`, `info` and `userId`, and offers:

| | |
|---|---|
| `send(input)` | Send input. Resolves with the rules' reply, rejects with `{ code, msg }` |
| `save()` | Save now. Owner only unless the type says otherwise |
| `onState`, `onLive`, `onPlayers` | Listen; each is called with the document and `{ changes }` (or `{ snapshot: true }`) |
| `onEvent([name], fn)` | Something the game announced with `session.emit` |
| `onSettings`, `onStatus`, `onClosed`, `onError` | |
| `status` | `connecting`, `live`, `reconnecting` or `closed` |
| `resync()`, `close()` | |

It keeps itself in step. A snapshot is fetched on connect and after every reconnect. Each patch carries a version: the next is applied, one already seen is ignored, and a gap (a patch was skipped for a client that was behind) triggers a fresh snapshot rather than a guess. If the server restarted, the game is opened again by itself and play resumes.

The other calls are `listTypes`, `listGames`, `getGame`, `createGame`, `updateGame`, `deleteGame`, `invitePlayer(gameId, { email })`, `acceptInvite`, `declineInvite`, `leaveGame`, `removePlayer`, `transferOwnership` and, for administrators, `listAllGames`.

### The lobby

```html
<script type="module" src="/game/components/Lobby.js"></script>
<k-game-lobby></k-game-lobby>            <!-- or type="my-ext:my-game" to offer one game -->
```

My games and invitations, a form to start a new game, inviting by email, accepting and declining, leaving and deleting. **Play** goes to the type's `playUrl`. `/game/` is a page with just the lobby in it.

## Server SDK

```javascript
import { createGame, invitePlayer, joinGame, getSession } from 'kempo-game/sdk';
```

Everything returns `[error, data]`. These are the *data* operations: the routes decide who may call them. Pass `actorId` and the rules that belong to a game itself (only the owner invites, the owner cannot leave) are enforced here too; leave it off for server code that has already decided it is allowed.

| Function | |
|---|---|
| `createGame({ ownerId, type, name, settings })` | The creator is the joined owner. Settings are merged over the type's defaults |
| `getGame({ gameId })` | `{ game (with state), players, live }` |
| `listGames({ userId })` | Games and invitations for one user |
| `listAllGames({ limit, offset })` | Every game |
| `updateGameDetails({ gameId, actorId, name, settings })` | Owner only when `actorId` is given |
| `deleteGame({ gameId, actorId })` | Ends the game for everyone in it |
| `invitePlayer({ gameId, userId \| email, invitedBy })` | Fails when the game is full, counting invitations |
| `acceptInvite`, `declineInvite`, `leaveGame` | `({ gameId, userId })` |
| `removePlayer({ gameId, userId, actorId })` | The owner removes anyone but themselves; a player only themselves |
| `transferOwnership({ gameId, toUserId, actorId })` | To a player who has joined |
| `joinGame({ gameId, userId })` | Makes the game live and returns its `channel` |
| `saveGame({ gameId })` | Save a running game now |
| `getSession({ gameId })` | The live session of a game this process is running, or `null` |
| `listTypes()`, `getType(id)` | |
| `shutdownGames()` | Save and stop every running game. Call it from a graceful shutdown |

Limits are `400` for malformed input, `403` for a rule, `404`, `409` for a conflict (full, already invited, not joined), `413` for something over its size limit and `429` for owning too many games.

## Hooks

Other extensions react to games through kempo's hooks. Hooks are for **lifecycle**, not for input: kempo runs them one at a time and reads the hook table on every call, which suits an event that happens once and not one that happens twenty times a second. Per-input work belongs in your rules.

| Event | Data | |
|---|---|---|
| `game:created` | `{ gameId, type, ownerId }` | |
| `game:deleted` | `{ gameId, type, ownerId }` | |
| `game:player_invited` | `{ gameId, type, userId, invitedBy }` | |
| `game:player_joined` | `{ gameId, type, userId }` | |
| `game:player_left` | `{ gameId, type, userId, reason }` | `reason` is `left`, `removed` or `absent` |
| `game:ownership_changed` | `{ gameId, type, from, to }` | |
| `game:started` | `{ gameId, type }` | The game went live on this process |
| `game:ended` | `{ gameId, type, reason }` | `idle`, `deleted`, `shutdown`, `stale`, `error` or `ended` |
| `game:saved` | `{ gameId, type, version, reason }` | `autosave`, `requested`, `manual` or `end` |
| `game:before_join` | `{ gameId, type, userId, stage }` | **Guard.** `stage` is `accept` or `play` |
| `game:before_save` | `{ gameId, type, reason, actorId }` | **Guard** |

A guard refuses by throwing `{ code, msg }`, and the player receives that code and message. Anything else it throws, or a database that cannot be reached, refuses with a generic `403` and logs the cause, so a broken guard fails closed and never leaks why.

## Saving

A running game is saved when:

- its timer fires and something changed (`autosave_seconds`, 30 by default, or the type's own), and never when nothing did;
- the owner asks (`game.save()`, or `POST /game/api/games/:id/save`), or any player if the type allows it;
- the last player leaves and the game ends;
- `shutdownGames()` runs.

A crash loses up to one autosave interval of `state`, and all of `live` unless your game folds it into `state`. A save writes `state` and every player's `data` in one transaction, is refused with a `413` over `max_state_bytes` (5 MB by default) and stays dirty so nothing is lost by the refusal, and can be refused by a `game:before_save` guard.

**A save is compared against a version.** It only lands if the version in the database is the one this process last read, then increments it. If another process has saved the game since (two processes both believed they were hosting it), the save is refused, this session ends and its players rejoin against what is stored, rather than one server quietly overwriting the other.

## Settings, permissions and groups

| Permission | |
|---|---|
| `game:play` | Create games, accept invitations, play. Granted by **kempo-game:player** |
| `game:admin` | See every game and delete any. Granted by **kempo-game:administrator**, with `game:play` |

Reaching the admin page also needs the site's own admin access. Membership of a particular game is checked on every join, subscribe and input.

| Setting | Default | |
|---|---|---|
| `autosave_seconds` | 30 | How often a running game with unsaved changes is saved. 0 turns automatic saving off |
| `idle_seconds` | 30 | How long an empty running game is kept before it is saved and stopped |
| `max_state_bytes` | 5000000 | The largest saved state |
| `max_settings_bytes` | 100000 | The largest game settings |
| `max_games_per_user` | 50 | Games one user may own. 0 is unlimited |

Realtime limits (per connection and per user) are kempo's: `KEMPO_REALTIME_MAX_MESSAGES_PER_SECOND` (100) and `KEMPO_REALTIME_MAX_CONNECTIONS_PER_USER` (10). A game taking input faster than a hundred messages a second per player needs the first raised.

## Running it in production

- **One process hosts a game.** A game's channel is delivered in memory on the process that runs it and never through Postgres, which is what makes twenty updates a second from each of twenty players affordable. Everyone in a game must therefore reach the same process. A default kempo install is one process and this never comes up. With several, route by game id (a sticky route on the game's URL or a cookie) at the load balancer. Someone connected to a process that is not running their game is refused with a `404`, and the frontend then opens the game again on the process it reached.
- **Behind a proxy**, set kempo-server's `websocket.trustProxy` so its per-address limits count the visitor and not the proxy.
- **Shut down gracefully.** Call `shutdownGames()` when the process is asked to stop; otherwise up to one autosave interval of changes is lost.
- **A patch has to fit in 1,000,000 bytes**, kempo's limit for one message on a channel. A tick that changes more than that (replacing a huge array, say) is refused and logged, and the players would then fall out of step and resync. Keep large data in objects changed piece by piece. The full snapshot a player receives when they join is not subject to that limit but is sent whole, so a very large world makes for a slow join.
- **Inviting by email tells the owner whether an account exists** for that address. That is the price of being able to invite someone by the address you know.

## What it can carry

Measured with `tests/capacity.node-test.js`: a real kempo-server, 20 players in a game each clicking 20 times a second, every click stamped and timed as it arrives at the other 19 players (through the socket, the game's rules, the tick that batches the change, the patch and the client applying it). Once with one game and once with ten at the same time, on one process.

| | Clicks a second in | p50 | p95 | p99 | Slowest | Lost | Database writes |
|---|---|---|---|---|---|---|---|
| 1 game, 20 players | 398 | 32 ms | 63 ms | 64 ms | 66 ms | 0 | 0 |
| 10 games, 200 players | 3,975 | 32 ms | 66 ms | 72 ms | 79 ms | 0 | 0 |

The median is about half a tick: at 20 steps a second a change waits, on average, 25 ms for the tick that carries it, and a higher `tickRate` lowers it. Read the numbers with their caveats: it is loopback, so the network contributes nothing and a real player adds their round-trip time to every figure; the clients share the machine and an event loop with each other and the measurement; and the players in the ten-game run share sockets, one per user. A turn-based game costs almost nothing by comparison.

## Tests

```bash
docker compose up -d                                              # a throwaway Postgres on port 5440
npm install && npm run link:local                                 # kempo, kempo-server and kempo-ui from sibling checkouts
DATABASE_URL=postgresql://kempo:kempo@localhost:5440/kempo_game_test npx drizzle-kit push --force
DATABASE_URL=postgresql://kempo:kempo@localhost:5440/kempo_game_test npm test
```

The database suites report `(SKIPPED)` and count as passing when no database is reachable, so check for that word before trusting a green run. They also refuse to run against a database whose name does not end in `_test`, because they delete every game and every test user.

What is covered, and each property has been checked to fail when the code providing it is removed:

- `tracker` and `connection`: the change format converges under random writes, and the browser connection stays in step through gaps, repeats, slow snapshots and a restarted server. No database.
- `games`: creating, inviting, accepting, leaving, removing, transferring, limits and hooks, against a real database and a real install.
- `live`: a running game with the clock and realtime replaced, so half a minute of autosaves runs in a moment: batching, saving only what changed, the version check, ending, presence and removal.
- `click-race`: a real server, real users and real WebSocket clients playing the test game to a win.
- `capacity`: the figures above.

The test game, "click race", lives in `tests/fixtures` and is never published. Two players click as fast as they can and the first to the target wins: the scores are `live` and never saved, the result is `state` and saved once.

## Not included

- **A game.** Rules, rendering and content belong to your extension.
- **Several processes running one game.** See [Running it in production](#running-it-in-production).
- **Client-side prediction, interpolation and lag compensation.** A game does those in its own client code.
- **Matchmaking, public game lists, spectators and chat.** Chat is a channel a game or another extension can add.
- **Billing.** Access is `game:play` plus membership, which is where a paywall would sit; nothing here charges anyone.
- **Save history or undo.** One current state per game.
