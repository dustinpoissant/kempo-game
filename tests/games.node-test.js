import { setSetting } from 'kempo/server/sdk.js';
import {
  databaseReachable, skipped, install, uninstall, purgeData, makeUser, installHooks, removeHooks, hookLog,
  expect, FIXTURE, db, kempoGame, kempoGamePlayer,
} from './helpers/harness.js';
import {
  createGame, getGame, listGames, updateGameDetails, deleteGame, invitePlayer, acceptInvite, declineInvite,
  removePlayer, leaveGame, transferOwnership, listTypes, getType,
} from '../sdk.js';
import { eq } from 'drizzle-orm';

/*
  Games and their players, against a real database and a real kempo, with the extension and a test game
  installed the way a site installs them.

  The rules under test belong to a game itself and are true whoever asks, so most calls pass `actorId`,
  which is how the routes call them.
*/

const RACE = `${FIXTURE}:click-race`;
const TURNS = `${FIXTURE}:turns`;

const ok = ([error, data], what) => {
  expect(error === null, `${what} should succeed, got ${JSON.stringify(error)}`);
  return data;
};

const refused = ([error, data], code, what) => {
  expect(error?.code === code && data === null, `${what} should be refused with ${code}, got ${JSON.stringify([error, data])}`);
  return error;
};

const suite = () => ({
  'the types a game extension declares are found, and one that cannot be honoured is left out': async ({ pass }) => {
    const types = await listTypes();
    const ids = types.map(type => type.id).sort();
    expect(ids.join() === [`${FIXTURE}:click-race`, `${FIXTURE}:crowd`, `${FIXTURE}:turns`, `${FIXTURE}:plain`].sort().join(), `expected the four valid types, got ${ids}`);
    expect(!ids.includes(`${FIXTURE}:broken`), 'a type whose module leaves the package must be left out, not half-working');

    const race = await getType(RACE);
    expect(race.minPlayers === 2 && race.maxPlayers === 2 && race.tickRate === 20 && race.autosaveSeconds === 2, `options should be read from the declaration, got ${JSON.stringify(race)}`);
    expect(race.defaultSettings.target === 100, 'default settings should come through');

    const turns = await getType(TURNS);
    expect(turns.tickRate === 0 && turns.autosaveSeconds === 0 && turns.removeAfterSeconds === 1 && turns.allowPlayerSave === true, 'a type with no tick and its own timings should be read as declared');

    expect(await getType('nobody:nothing') === null && await getType(undefined) === null, 'an unknown type is null');
    pass('types');
  },

  'creating a game makes the creator its joined owner, with the state its rules gave it': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');

    const { game } = ok(await createGame({ ownerId: ann.id, type: RACE, name: '  Friday race  ', settings: { target: 5 } }), 'creating a game');
    expect(game.name === 'Friday race' && game.ownerId === ann.id && game.type === RACE, `unexpected game ${JSON.stringify(game)}`);
    expect(game.settings.target === 5, 'a setting given at creation is kept');

    const data = ok(await getGame({ gameId: game.id }), 'reading it back');
    expect(data.game.state.target === 5 && data.game.state.status === 'racing', `the state should be what onCreate returned, got ${JSON.stringify(data.game.state)}`);
    expect(data.players.length === 1 && data.players[0].userId === ann.id && data.players[0].role === 'owner' && data.players[0].status === 'joined', 'the creator is the joined owner');
    expect(data.players[0].name === ann.name, 'players are named');
    expect(data.live === false, 'a game nobody has opened is not running');

    const defaulted = ok(await createGame({ ownerId: ann.id, type: RACE, name: 'Defaults' }), 'a game with no settings');
    expect(defaulted.game.settings.target === 100, 'the type\'s default settings fill in what was not given');
    pass('create');
  },

  'creating a game is refused for anything malformed': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');

    refused(await createGame({ ownerId: ann.id, type: RACE, name: '' }), 400, 'an empty name');
    refused(await createGame({ ownerId: ann.id, type: RACE, name: '   ' }), 400, 'a blank name');
    refused(await createGame({ ownerId: ann.id, type: RACE, name: 'x'.repeat(121) }), 400, 'a name over 120 characters');
    refused(await createGame({ ownerId: ann.id, type: 'nobody:nothing', name: 'X' }), 400, 'an unknown type');
    refused(await createGame({ ownerId: ann.id, type: `${FIXTURE}:broken`, name: 'X' }), 400, 'a type that was left out');
    refused(await createGame({ ownerId: ann.id, type: RACE, name: 'X', settings: [1] }), 400, 'settings that are an array');
    refused(await createGame({ ownerId: ann.id, type: RACE, name: 'X', settings: 'text' }), 400, 'settings that are text');
    refused(await createGame({ type: RACE, name: 'X' }), 400, 'no owner');
    refused(await createGame({ ownerId: 'no-such-user', type: RACE, name: 'X' }), 404, 'an owner that does not exist');
    refused(await createGame({ ownerId: ann.id, type: RACE, name: 'X', settings: { blob: 'x'.repeat(200000) } }), 413, 'settings over the size limit');

    expect((await db.select().from(kempoGame)).length === 0, 'nothing was created by any of them');
    pass('create validation');
  },

  'a user can own only as many games as the site allows': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    await setSetting('kempo-game', 'max_games_per_user', '2', 'number');
    try {
      ok(await createGame({ ownerId: ann.id, type: RACE, name: 'One' }), 'the first');
      ok(await createGame({ ownerId: ann.id, type: RACE, name: 'Two' }), 'the second');
      refused(await createGame({ ownerId: ann.id, type: RACE, name: 'Three' }), 429, 'a third game');
      ok(await createGame({ ownerId: bob.id, type: RACE, name: 'Bob\'s' }), 'another user\'s first, since the limit is per owner');
    } finally {
      await setSetting('kempo-game', 'max_games_per_user', '50', 'number');
    }
    pass('per-user limit');
  },

  'only the owner invites; an invitee accepts or declines; a full game takes no more': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const cat = await makeUser('cat');
    const dan = await makeUser('dan');
    const { game } = ok(await createGame({ ownerId: ann.id, type: RACE, name: 'Two players' }), 'creating');
    const gameId = game.id;

    refused(await invitePlayer({ gameId, userId: cat.id, invitedBy: bob.id }), 403, 'someone who is not the owner inviting');
    refused(await invitePlayer({ gameId: 'nope', userId: bob.id, invitedBy: ann.id }), 404, 'a game that does not exist');
    refused(await invitePlayer({ gameId, userId: 'no-such-user', invitedBy: ann.id }), 404, 'a user that does not exist');
    refused(await invitePlayer({ gameId, email: 'nobody@nowhere.test', invitedBy: ann.id }), 404, 'an email with no account');
    refused(await invitePlayer({ gameId, invitedBy: ann.id }), 400, 'no one named');

    const invited = ok(await invitePlayer({ gameId, email: bob.email, invitedBy: ann.id }), 'inviting by email');
    expect(invited.player.status === 'invited' && invited.player.role === 'player' && invited.player.userId === bob.id, 'by email finds the account');
    refused(await invitePlayer({ gameId, userId: bob.id, invitedBy: ann.id }), 409, 'inviting the same person twice');
    refused(await invitePlayer({ gameId, userId: cat.id, invitedBy: ann.id }), 409, 'a third person into a two-player game, counting the invitation that is pending');

    // Nothing joined yet: the invitee cannot open it
    const beforeAccept = ok(await listGames({ userId: bob.id }), 'bob\'s games');
    expect(beforeAccept.games.length === 1 && beforeAccept.games[0].membership.status === 'invited', 'the invitation shows in the invitee\'s list, as an invitation');

    refused(await acceptInvite({ gameId, userId: cat.id }), 404, 'accepting without being invited');
    ok(await acceptInvite({ gameId, userId: bob.id }), 'accepting');
    ok(await acceptInvite({ gameId, userId: bob.id }), 'accepting twice is harmless');

    const players = ok(await getGame({ gameId }), 'reading').players;
    expect(players.filter(player => player.status === 'joined').length === 2, 'both are joined');
    refused(await invitePlayer({ gameId, userId: dan.id, invitedBy: ann.id }), 409, 'a game that is full');

    // Declining
    const { game: other } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Three players' }), 'creating another');
    ok(await invitePlayer({ gameId: other.id, userId: cat.id, invitedBy: ann.id }), 'inviting cat');
    ok(await declineInvite({ gameId: other.id, userId: cat.id }), 'declining');
    refused(await declineInvite({ gameId: other.id, userId: cat.id }), 404, 'declining what is no longer an invitation');
    refused(await acceptInvite({ gameId: other.id, userId: cat.id }), 404, 'accepting after declining');
    expect(ok(await listGames({ userId: cat.id }), 'cat\'s games').games.length === 0, 'a declined game is gone from the list');

    const again = ok(await invitePlayer({ gameId: other.id, userId: cat.id, invitedBy: ann.id }), 're-inviting someone who declined');
    expect(again.player.status === 'invited', 'they can be invited again');
    ok(await acceptInvite({ gameId: other.id, userId: cat.id }), 'and accept this time');
    pass('invitations');
  },

  'the owner cannot leave; players can; only the owner removes others': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const cat = await makeUser('cat');
    const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Removals' }), 'creating');
    const gameId = game.id;
    for(const user of [bob, cat]){
      ok(await invitePlayer({ gameId, userId: user.id, invitedBy: ann.id }), 'inviting');
      ok(await acceptInvite({ gameId, userId: user.id }), 'accepting');
    }

    refused(await leaveGame({ gameId, userId: ann.id }), 409, 'the owner leaving');
    refused(await removePlayer({ gameId, userId: ann.id, actorId: ann.id }), 409, 'the owner removing themselves');
    refused(await removePlayer({ gameId, userId: cat.id, actorId: bob.id }), 403, 'a player removing another player');
    refused(await removePlayer({ gameId, userId: 'stranger', actorId: ann.id }), 404, 'removing someone who is not in it');

    ok(await removePlayer({ gameId, userId: cat.id, actorId: ann.id }), 'the owner removing a player');
    ok(await leaveGame({ gameId, userId: bob.id }), 'a player leaving');
    const remaining = ok(await getGame({ gameId }), 'reading').players;
    expect(remaining.length === 1 && remaining[0].userId === ann.id, 'only the owner is left');

    // Withdrawing an invitation is the same operation
    ok(await invitePlayer({ gameId, userId: bob.id, invitedBy: ann.id }), 'inviting');
    ok(await removePlayer({ gameId, userId: bob.id, actorId: ann.id }), 'withdrawing the invitation');
    refused(await acceptInvite({ gameId, userId: bob.id }), 404, 'accepting a withdrawn invitation');
    pass('leaving and removing');
  },

  'ownership passes only to a player who has joined, and the old owner may then leave': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const cat = await makeUser('cat');
    const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Handover' }), 'creating');
    const gameId = game.id;
    ok(await invitePlayer({ gameId, userId: bob.id, invitedBy: ann.id }), 'inviting bob');
    ok(await invitePlayer({ gameId, userId: cat.id, invitedBy: ann.id }), 'inviting cat');
    ok(await acceptInvite({ gameId, userId: bob.id }), 'bob accepting');

    refused(await transferOwnership({ gameId, toUserId: bob.id, actorId: bob.id }), 403, 'someone who is not the owner transferring');
    refused(await transferOwnership({ gameId, toUserId: cat.id, actorId: ann.id }), 409, 'to someone who has only been invited');
    refused(await transferOwnership({ gameId, toUserId: 'stranger', actorId: ann.id }), 409, 'to someone who is not in the game');
    refused(await transferOwnership({ gameId, toUserId: ann.id, actorId: ann.id }), 409, 'to themselves');

    ok(await transferOwnership({ gameId, toUserId: bob.id, actorId: ann.id }), 'transferring to bob');
    const after = ok(await getGame({ gameId }), 'reading');
    expect(after.game.ownerId === bob.id, 'the game names its new owner');
    expect(after.players.find(player => player.userId === bob.id).role === 'owner' && after.players.find(player => player.userId === ann.id).role === 'player', 'the roles swapped');

    refused(await updateGameDetails({ gameId, actorId: ann.id, name: 'Hijack' }), 403, 'the old owner changing the game');
    ok(await leaveGame({ gameId, userId: ann.id }), 'the old owner can now leave');
    pass('transfer');
  },

  'only the owner renames or reconfigures a game, and what they send is validated': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Before', settings: { a: 1 } }), 'creating');
    ok(await invitePlayer({ gameId: game.id, userId: bob.id, invitedBy: ann.id }), 'inviting');
    ok(await acceptInvite({ gameId: game.id, userId: bob.id }), 'accepting');

    refused(await updateGameDetails({ gameId: game.id, actorId: bob.id, name: 'Mine now' }), 403, 'a player renaming');
    refused(await updateGameDetails({ gameId: game.id, actorId: ann.id }), 400, 'changing nothing');
    refused(await updateGameDetails({ gameId: game.id, actorId: ann.id, name: '' }), 400, 'an empty name');
    refused(await updateGameDetails({ gameId: game.id, actorId: ann.id, settings: [] }), 400, 'array settings');
    refused(await updateGameDetails({ gameId: game.id, actorId: ann.id, settings: { blob: 'x'.repeat(200000) } }), 413, 'oversized settings');
    refused(await updateGameDetails({ gameId: 'nope', actorId: ann.id, name: 'X' }), 404, 'a game that does not exist');

    const updated = ok(await updateGameDetails({ gameId: game.id, actorId: ann.id, name: ' After ', settings: { b: 2 } }), 'the owner changing it');
    expect(updated.game.name === 'After' && updated.game.settings.b === 2 && updated.game.settings.a === undefined, `settings are replaced, not merged, got ${JSON.stringify(updated.game)}`);
    pass('update');
  },

  'my games lists mine and my invitations, and nobody else\'s': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const cat = await makeUser('cat');
    const { game: annsGame } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Ann\'s' }), 'ann creating');
    const { game: bobsGame } = ok(await createGame({ ownerId: bob.id, type: TURNS, name: 'Bob\'s' }), 'bob creating');
    ok(await invitePlayer({ gameId: bobsGame.id, userId: ann.id, invitedBy: bob.id }), 'bob inviting ann');

    const anns = ok(await listGames({ userId: ann.id }), 'ann\'s games').games;
    const byName = Object.fromEntries(anns.map(game => [game.name, game]));
    expect(anns.length === 2, `ann is in one game and invited to another, got ${anns.length}`);
    expect(byName['Ann\'s'].membership.role === 'owner' && byName['Ann\'s'].membership.status === 'joined' && byName['Ann\'s'].playerCount === 1, 'her own game');
    expect(byName['Bob\'s'].membership.status === 'invited' && byName['Bob\'s'].membership.invitedBy === bob.id, 'the invitation says who invited her');
    expect(!('state' in anns[0]), 'a list carries no state');

    expect(ok(await listGames({ userId: cat.id }), 'cat\'s games').games.length === 0, 'a stranger sees none of them');
    refused(await listGames({}), 400, 'no user');
    expect(annsGame.id !== bobsGame.id, 'distinct');
    pass('listing');
  },

  'deleting a game removes it and everyone\'s place in it, and only the owner may': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Doomed' }), 'creating');
    ok(await invitePlayer({ gameId: game.id, userId: bob.id, invitedBy: ann.id }), 'inviting');
    ok(await acceptInvite({ gameId: game.id, userId: bob.id }), 'accepting');

    refused(await deleteGame({ gameId: game.id, actorId: bob.id }), 403, 'a player deleting');
    refused(await deleteGame({ gameId: 'nope', actorId: ann.id }), 404, 'a game that does not exist');
    expect((await db.select().from(kempoGame)).length === 1, 'the refused attempts changed nothing');

    ok(await deleteGame({ gameId: game.id, actorId: ann.id }), 'the owner deleting');
    expect((await db.select().from(kempoGame).where(eq(kempoGame.id, game.id))).length === 0, 'the game is gone');
    expect((await db.select().from(kempoGamePlayer).where(eq(kempoGamePlayer.gameId, game.id))).length === 0, 'and so is everyone\'s place in it');
    refused(await getGame({ gameId: game.id }), 404, 'reading it');
    pass('delete');
  },

  'other extensions hear about it through hooks, with the documented data': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    await installHooks(['game:created', 'game:player_invited', 'game:player_joined', 'game:player_left', 'game:ownership_changed', 'game:deleted']);
    try {
      const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Observed' }), 'creating');
      ok(await invitePlayer({ gameId: game.id, userId: bob.id, invitedBy: ann.id }), 'inviting');
      ok(await acceptInvite({ gameId: game.id, userId: bob.id }), 'accepting');
      ok(await transferOwnership({ gameId: game.id, toUserId: bob.id, actorId: ann.id }), 'transferring');
      ok(await removePlayer({ gameId: game.id, userId: ann.id, actorId: bob.id }), 'removing');
      ok(await deleteGame({ gameId: game.id, actorId: bob.id }), 'deleting');

      const seen = hookLog();
      const events = seen.map(entry => entry.event);
      expect(events.join() === 'game:created,game:player_invited,game:player_joined,game:ownership_changed,game:player_left,game:deleted', `unexpected events ${events}`);
      expect(seen[0].gameId === game.id && seen[0].type === TURNS && seen[0].ownerId === ann.id, 'created carries the game, type and owner');
      expect(seen[1].userId === bob.id && seen[1].invitedBy === ann.id, 'invited carries who and by whom');
      expect(seen[2].userId === bob.id, 'joined carries who');
      expect(seen[3].from === ann.id && seen[3].to === bob.id, 'ownership carries from and to');
      expect(seen[4].userId === ann.id && seen[4].reason === 'removed', 'left carries who and why');
      expect(seen[5].gameId === game.id && seen[5].ownerId === bob.id, 'deleted carries the game and its owner then');
    } finally {
      await removeHooks();
    }
    pass('hooks');
  },

  'a guard hook can refuse someone joining, and a hook that fails cannot leak why': async ({ pass }) => {
    await purgeData();
    const ann = await makeUser('ann');
    const bob = await makeUser('bob');
    const cat = await makeUser('cat');
    const { game } = ok(await createGame({ ownerId: ann.id, type: TURNS, name: 'Guarded' }), 'creating');
    for(const user of [bob, cat]) ok(await invitePlayer({ gameId: game.id, userId: user.id, invitedBy: ann.id }), 'inviting');

    await installHooks(['game:before_join'], { refuse: bob.id });
    try {
      const refusal = refused(await acceptInvite({ gameId: game.id, userId: bob.id }), 451, 'a guard that refuses');
      expect(refusal.msg === 'Not today', 'the hook\'s own message reaches the player');
      expect((await getGame({ gameId: game.id }))[1].players.find(player => player.userId === bob.id).status === 'invited', 'a refused player is still only invited');
      ok(await acceptInvite({ gameId: game.id, userId: cat.id }), 'a player the guard has no objection to');
      expect(hookLog().some(entry => entry.userId === cat.id && entry.stage === 'accept' && entry.gameId === game.id), 'the guard is told who, which game and at which stage');
    } finally {
      await removeHooks();
    }

    await installHooks(['game:before_join'], { explode: bob.id });
    try {
      const refusal = refused(await acceptInvite({ gameId: game.id, userId: bob.id }), 403, 'a guard that throws something it should not');
      expect(!/secret/.test(refusal.msg), `a hook's internal error must not reach the player, got "${refusal.msg}"`);
    } finally {
      await removeHooks();
    }
    pass('guard');
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
  : skipped('games');
