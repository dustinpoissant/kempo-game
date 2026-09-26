import ShadowComponent from '/kempo-ui/components/ShadowComponent.js';
import '/kempo-ui/components/Icon.js';
import { html } from '/kempo-ui/lit-all.min.js';
import { listGames, listTypes, createGame, invitePlayer, acceptInvite, declineInvite, leaveGame, deleteGame } from '/game/sdk.js';

/*
  My games and my invitations, as one element, so a game extension does not have to build a lobby.

  It knows nothing about any particular game. It lists what the signed-in player is in, lets them make a
  new game of any installed type (or of the one type named by the `type` attribute), invite people by
  email, accept or decline an invitation, and leave or delete. "Play" goes to the page the game type
  declared with `playUrl`, since only the game knows what its own screen is.

  Nothing here decides who may do what. Every button calls a route that decides again, so a button that is
  shown to someone who should not have it is a wrong label and never a hole.
*/
export default class GameLobby extends ShadowComponent {
  static properties = {
    type: { type: String },
    games: { state: true },
    types: { state: true },
    loading: { state: true },
    error: { state: true },
    inviting: { state: true },
    confirming: { state: true },
    note: { state: true },
  };

  constructor(){
    super();
    this.type = '';
    this.games = [];
    this.types = [];
    this.loading = true;
    this.error = '';
    this.inviting = null;
    this.confirming = null;
    this.note = '';
  }

  connectedCallback(){
    super.connectedCallback();
    this.refresh();
  }

  /*
    Data
  */

  refresh = async () => {
    const [[gamesError, gamesData], [typesError, typesData]] = await Promise.all([listGames(), listTypes()]);
    this.loading = false;

    if(gamesError || typesError){
      const first = gamesError || typesError;
      this.error = first.code === 401 ? 'Sign in to see your games.' : first.code === 403 ? 'Your account cannot play games yet.' : first.msg;
      return;
    }

    this.error = '';
    this.games = gamesData.games;
    this.types = typesData.types;
  };

  get offered(){
    return this.type ? this.types.filter(type => type.id === this.type) : this.types;
  }

  typeOf = id => this.types.find(type => type.id === id);

  /*
    Actions. Each runs the call, reports what went wrong in words, and reloads, so the list is always what
    the server says and never what this element expects.
  */

  act = (call, success) => async () => {
    const [error] = await call();
    this.error = error ? error.msg : '';
    this.note = error ? '' : (success || '');
    this.confirming = null;
    if(!error) this.inviting = null;
    await this.refresh();
  };

  create = async (event) => {
    event.preventDefault();
    const form = event.target;
    const type = form.elements.type.value;
    const name = form.elements.name.value;

    const [error, data] = await createGame({ type, name });
    this.error = error ? error.msg : '';
    this.note = error ? '' : `Created "${data.game.name}".`;
    if(!error){
      form.reset();
      this.dispatchEvent(new CustomEvent('created', { detail: { game: data.game }, bubbles: true, composed: true }));
    }
    await this.refresh();
  };

  invite = gameId => async (event) => {
    event.preventDefault();
    const email = event.target.elements.email.value;
    const [error] = await invitePlayer(gameId, { email });
    this.error = error ? error.msg : '';
    this.note = error ? '' : `Invited ${email}.`;
    if(!error) this.inviting = null;
    await this.refresh();
  };

  /*
    Rendering
  */

  render(){
    if(this.loading) return html`<p class="tc-muted">Loading your games…</p>`;

    const invitations = this.games.filter(game => game.membership.status === 'invited');
    const mine = this.games.filter(game => game.membership.status === 'joined');

    return html`
      ${this.error ? html`<p class="tc-danger" role="alert">${this.error}</p>` : ''}
      ${this.note ? html`<p class="tc-success">${this.note}</p>` : ''}
      ${this.renderCreate()}
      ${invitations.length ? this.renderInvitations(invitations) : ''}
      ${this.renderGames(mine)}
    `;
  }

  renderCreate(){
    const types = this.offered;
    if(!types.length) return html`<p class="tc-muted">No games are installed yet.</p>`;

    return html`
      <form class="d-f mb" style="gap: var(--spacer_h); align-items: end;" @submit=${this.create}>
        ${types.length > 1 ? html`
          <label class="flex">
            Game
            <select name="type">${types.map(type => html`<option value=${type.id}>${type.label}</option>`)}</select>
          </label>
        ` : html`<input type="hidden" name="type" value=${types[0].id} />`}
        <label class="flex">
          Name
          <input type="text" name="name" required maxlength="120" placeholder="My game" />
        </label>
        <button class="btn primary" type="submit"><k-icon name="add"></k-icon> New game</button>
      </form>
    `;
  }

  renderInvitations(invitations){
    return html`
      <h2>Invitations</h2>
      <ul class="mb">
        ${invitations.map(game => html`
          <li class="d-f mbq" style="gap: var(--spacer_h); align-items: center;">
            <span class="flex"><strong>${game.name}</strong> <span class="tc-muted small">${this.typeOf(game.type)?.label || game.type}</span></span>
            <button class="btn primary" @click=${this.act(() => acceptInvite(game.id), 'You joined the game.')}><k-icon name="check"></k-icon> Accept</button>
            <button class="btn" @click=${this.act(() => declineInvite(game.id))}><k-icon name="close"></k-icon> Decline</button>
          </li>
        `)}
      </ul>
    `;
  }

  renderGames(games){
    if(!games.length) return html`<p class="tc-muted">You are not in any games yet.</p>`;

    return html`
      <h2>Your games</h2>
      <ul>
        ${games.map(game => this.renderGame(game))}
      </ul>
    `;
  }

  renderGame(game){
    const type = this.typeOf(game.type);
    const owner = game.membership.role === 'owner';
    const playUrl = type?.playUrl ? type.playUrl.replace('{id}', encodeURIComponent(game.id)) : null;
    const confirming = this.confirming === game.id;

    return html`
      <li class="mb">
        <div class="d-f" style="gap: var(--spacer_h); align-items: center;">
          <span class="flex">
            <strong>${game.name}</strong>
            <span class="tc-muted small">${type?.label || game.type} · ${game.playerCount}${type ? ` of ${type.maxPlayers}` : ''} players${owner ? ' · you own this' : ''}${game.live ? ' · running' : ''}</span>
          </span>
          ${playUrl ? html`<a class="btn primary" href=${playUrl}>Play</a>` : ''}
          ${owner ? html`<button class="btn" @click=${() => { this.inviting = this.inviting === game.id ? null : game.id; }}><k-icon name="person_add"></k-icon> Invite</button>` : ''}
          ${confirming ? html`
            <span>${owner ? 'Delete this game for everyone?' : 'Leave this game?'}</span>
            <button class="btn danger" @click=${this.act(() => (owner ? deleteGame(game.id) : leaveGame(game.id)), owner ? 'Game deleted.' : 'You left the game.')}>Yes</button>
            <button class="btn" @click=${() => { this.confirming = null; }}>No</button>
          ` : html`
            <button class="btn" @click=${() => { this.confirming = game.id; }}>
              <k-icon name=${owner ? 'delete' : 'close'}></k-icon> ${owner ? 'Delete' : 'Leave'}
            </button>
          `}
        </div>
        ${this.inviting === game.id ? html`
          <form class="d-f mt" style="gap: var(--spacer_h);" @submit=${this.invite(game.id)}>
            <input class="flex" type="email" name="email" required placeholder="their email address" />
            <button class="btn primary" type="submit">Send invitation</button>
          </form>
        ` : ''}
      </li>
    `;
  }
}

customElements.define('k-game-lobby', GameLobby);
