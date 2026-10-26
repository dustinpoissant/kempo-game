import ButtonControl from '/kempo-ui/components/controls/ButtonControl.js';
import { html } from '/kempo-ui/lit-all.min.js';
import '/kempo-ui/components/Icon.js';

/*
  Deletes a game from its row. The page owns the confirmation and the request, so this reports the row as a
  `gameDelete` event on the table: { record }.

    <k-game-delete slot="after"></k-game-delete>
*/
export default class GameDelete extends ButtonControl {
  get record(){
    const index = this.closest('.record')?.dataset?.index;
    return index === undefined ? null : this.host?.records?.[index] ?? null;
  }

  connectedCallback(){
    super.connectedCallback();
    if(!this.hasAttribute('title')) this.title = 'Delete';
  }

  handleAction(){
    if(!this.record) return;
    this.host.dispatchEvent(new CustomEvent('gameDelete', { detail: { record: this.record } }));
  }

  render(){
    return html`<slot><k-icon name="delete"></k-icon></slot>`;
  }
}

customElements.define('k-game-delete', GameDelete);
