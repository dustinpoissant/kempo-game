# Changelog

All notable changes to `kempo-game` are documented in this file.

## [Unreleased]

First release.

A generic multiplayer game layer for kempo. It is not a game: it gives a game, which is its own kempo (CMS) extension, saved games with invited players, live sync between their browsers, saving, a backend SDK, hooks and a frontend SDK.

### Games and players

- A game has a name, a type, an owner, settings and state. One player or many: the owner invites by email, invitees accept or decline, the owner removes players and transfers ownership, players leave, and the owner cannot leave without transferring or deleting.
- A game type is declared in the game extension's `kempo-config.json` and read from the extension table, so nothing depends on load order and disabling the extension removes its types. The rules are a module loaded once and kept in memory.
- Access is `game:play` plus membership of the particular game, checked on every join, subscribe and input. The **kempo-game:player** group grants `game:play`; **kempo-game:administrator** adds `game:admin`.
- Limits: games per owner, settings size, state size, and a per-type player range.

### Live sync

- One process-scoped realtime channel per running game, registered when the game goes live and removed when it ends. Delivered in memory, never through Postgres.
- Three documents kept identical on every player's browser: `state` (saved), `live` (never saved by the sync path) and the roster. Writes made through `session.state` and `session.live` are noticed automatically and sent as small change lists, batched per tick, each with a version so a client can tell a patch it has seen, the next one, and a gap.
- A browser connection that stays in step through reconnects, dropped patches and a restarted server, and opens the game again by itself.
- A tick loop that runs only while someone is connected. Events to everyone or to one player.

### Saving

- Automatic on a timer (30 seconds by default, per type overridable, only when something changed), on request, when the last player leaves, and on `shutdownGames()`.
- A save writes `state` and per-player data in one transaction and is compared against a version, so two processes hosting the same game cannot overwrite each other.
- A save can be refused by a `game:before_save` guard, or for exceeding `max_state_bytes`, and the game stays dirty.

### Interface

- `/game/sdk.js`, a `<k-game-lobby>` element, a `/game/` page, and an admin page listing every game with delete.
- Hooks for the whole lifecycle, and guards `game:before_join` and `game:before_save` that fail closed.

### Notes for anyone building on it

- A game must be reached on one process. With several processes, route by game id.
- Measured on one process over loopback: 20 players at 20 inputs a second in a game, and ten such games at once, lost nothing, wrote nothing to the database and had a median of 32 ms and a 99th percentile of 72 ms from one player's input to the others seeing it. See the README for the caveats.
- Requires kempo 4.4 or later, which added `realtime.unregisterChannel` and the browser client's `onSubscribed`.
