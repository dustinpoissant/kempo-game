import DashboardWidget from '/kempo/components/DashboardWidget.js';
import { html } from '/kempo-ui/lit-all.min.js';
import { listAllGames } from '/game/sdk.js';

/*
  How many games exist and the latest few.
*/
export default class GamesWidget extends DashboardWidget {
  static properties = {
    ...DashboardWidget.properties,
    games: { state: true }
  };

  constructor(){
    super();
    this.games = [];
    this.cta = { label: 'Manage games', icon: 'group', href: '/admin/extension/kempo-game/' };
  }

  /*
    Public Methods
  */

  load = async () => {
    const { games } = await this.unwrap(listAllGames());
    this.games = games.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  };

  /*
    Rendering
  */

  renderContent(){
    if(!this.games.length) return html`<p class="tc-muted">No games yet.</p>`;
    return html`
      <div class="h2 m0">${this.games.length}</div>
      <div class="small tc-muted mb">${this.games.length === 1 ? 'Game' : 'Games'}</div>
      ${this.games.slice(0, Math.max(this.height * 2 - 1, 1)).map(game => html`
        <div class="d-f pyq bb"><span class="flex">${game.name || game.id}</span><span class="small tc-muted">${game.type}</span></div>
      `)}
    `;
  }
}

customElements.define('k-game-widget', GamesWidget);
