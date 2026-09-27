import './ui.css';
import { MODES } from './ballMachine.js';
import { buildPauseMenu } from './menuModel.js';
import { getNarrationSettings, setNarrationEnabled, setNarratorMode, sendInvite } from './backendApi.js';
import { getLeaderboard, submitScore, isWorthRecording } from './leaderboard.js';

// The flat-screen shell: a retro start menu, a one-line status bar, and a
// settings screen built from the shared menu model.
//
// None of this exists inside a headset — the immersive session only renders
// the 3D scene — so the same menu model is drawn again in world space by
// vrMenu.js. This file is what you use before putting the headset on, and
// what the on-screen preview runs on.

// Names come from other players through the leaderboard, so they are text to
// display, never markup to run.
function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

export class UI {
  // `isInputBlocked` lets the caller veto keyboard commands — the in-headset
  // menu uses it so a keypress can't drive the game from behind an open
  // pause screen.
  constructor({
    xr,
    machine,
    game,
    settings,
    sfx,
    onStart,
    onExit,
    isInputBlocked,
    onRecenter,
    onVersusCreate,
    onVersusJoin,
    onVersusLeave,
    onTournamentCreate,
    onTournamentJoin,
    onTournamentStart,
    onTournamentLeave,
    onTournamentDispute,
    onTournamentLaunch,
    onPhonePair,
    onRunSummary,
    invitedRoom = null,
    invitedTournament = null,
    realtimeAvailable = false,
    relayAvailable = false,
  }) {
    Object.assign(this, {
      xr,
      machine,
      game,
      settings,
      sfx,
      onStart,
      onExit,
      onRecenter,
      onVersusCreate,
      onVersusJoin,
      onVersusLeave,
      onTournamentCreate,
      onTournamentJoin,
      onTournamentStart,
      onTournamentLeave,
    onTournamentDispute,
      onTournamentLaunch,
      onPhonePair,
      onRunSummary,
      realtimeAvailable,
      relayAvailable,
    });
    this.isInputBlocked = isInputBlocked ?? (() => false);

    this._selected = 0;
    this._entries = [];
    this._toastTimer = null;
    this._lastRevision = -1;
    this._versus = null; // { role, code, link, kind } once a room is open
    this._tournament = null; // { code, link, players, isHost } once in a bracket lobby
    this._tournamentStarted = false;
    this._tournamentMatch = null;
    this._phoneReadyStarted = false;

    this._buildMenu();
    this._buildBar();
    this._buildSettings();
    this._buildToast();
    this._buildCoachPanel();
    this._buildTournamentHud();
    this._buildVersusHud();
    this._buildScores();
    this._buildCamPreview();

    window.addEventListener('keydown', (e) => this._onKey(e));
    this.showMenu();

    // Arriving on a ?room=CODE link is an invitation, so the menu opens on
    // Versus with the code already filled in — one button from playing.
    if (invitedTournament) {
      this.chooseGame('tournament');
      this.lobbyCode.value = invitedTournament;
      this._setLobbyStatus(`Invited to tournament ${invitedTournament} — join the bracket.`);
    } else if (invitedRoom) {
      this.chooseGame('friend');
      this.lobbyCode.value = invitedRoom;
      this._setLobbyStatus(`Invited to room ${invitedRoom} — join to play.`);
    }
  }

  // --- Start menu -------------------------------------------------------

  _buildMenu() {
    const el = document.createElement('div');
    el.id = 'menu';
    // A full-screen menu over the arena is a dialog as far as assistive tech is
    // concerned, and naming it gives the screen a landmark instead of a wall of
    // anonymous buttons.
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'PaddleLab start menu');
    el.innerHTML = `
      <div class="crt"></div>
      <div>
        <h1 class="title">Paddle<span>·</span>Lab XR<span class="blink">_</span></h1>
        <p class="tagline">Hack the North 2026</p>
      </div>

      <div class="screen" data-screen="game">
        <div class="step__head"><span class="step__num">1</span>What do you want to play?</div>
        <div class="game-pick">
          <button class="game" data-game="tournament">
            <span class="game__key">1</span>
            <span class="game__name">Create a tournament</span>
            <span class="game__blurb">Bracket play · beta</span>
          </button>
          <button class="game" data-game="friend">
            <span class="game__key">2</span>
            <span class="game__name">Play a friend</span>
            <span class="game__blurb">Online match · beta</span>
          </button>
          <button class="game" data-game="bot">
            <span class="game__key">3</span>
            <span class="game__name">Play a standard bot</span>
            <span class="game__blurb">A physical AI opponent</span>
          </button>
          <button class="game" data-game="fly">
            <span class="game__key">4</span>
            <span class="game__name">Play a fly</span>
            <span class="game__blurb">Connectome-driven opponent</span>
          </button>
          <button class="game" data-game="drills">
            <span class="game__key">5</span>
            <span class="game__name">Drills</span>
            <span class="game__blurb">Practice shots against the machine</span>
          </button>
          <button class="game" data-game="coach">
            <span class="game__key">6</span>
            <span class="game__name">Coach</span>
            <span class="game__blurb">Learn one stroke at a time, scored</span>
          </button>
        </div>
        <div class="prompt blink">↑ ↓ SELECT · ENTER CONTINUE</div>
      </div>

      <div class="screen" data-screen="play" hidden>
        <button class="crumb" data-back>‹ <b data-crumb-game>ARCADE</b> — change game</button>
        <div class="step__head"><span class="step__num">2</span>What do you have?</div>
        <div class="menu-list" data-list></div>
        <div class="lobby" data-lobby hidden>
          <div class="step__head"><span class="step__num">✦</span>Set up the match</div>
          <div class="lobby__row">
            <button class="key" data-lobby-host><b>▸</b>Start a room</button>
            <span class="lobby__or">or join one</span>
            <input
              class="lobby__code"
              data-lobby-code
              maxlength="6"
              placeholder="CODE"
              autocomplete="off"
              spellcheck="false"
            />
            <button class="key" data-lobby-join><b>▸</b>Join</button>
            <button class="key" data-lobby-start hidden><b>▸</b>Start bracket</button>
          </div>
          <div class="lobby__status" data-lobby-status role="status" aria-live="polite"></div>
          <button class="key" data-lobby-dispute hidden><b>▸</b>Use my result</button>
          <div class="lobby__roster" data-lobby-roster role="status" aria-live="polite" hidden></div>
          <div class="lobby__share" data-lobby-share hidden>
            <span class="lobby__link" data-lobby-link></span>
            <button class="key" data-lobby-copy><b>⧉</b>Copy link</button>
            <button class="key" data-lobby-leave><b>×</b>Leave</button>
            <!-- Folded away by default: inviting somebody by text is a nice-to-
                 have, and three more controls sitting open turned the lobby
                 into a wall of inputs nobody had asked for. -->
            <details class="lobby__invite">
              <summary class="lobby__invite-label">Text an invite</summary>
              <div class="lobby__invite-row">
                <input class="lobby__phone" data-lobby-phone placeholder="+1 416…" inputmode="tel" autocomplete="tel" />
                <button class="key" data-lobby-invite><b>▸</b>Send iMessage</button>
              </div>
            </details>
          </div>
        </div>
        <div class="phone-pair" data-phone-pair hidden>
          <div class="phone-pair__title">▸ Phone paddle — scan to pair</div>
          <canvas class="phone-pair__qr" data-phone-qr width="168" height="168" role="img" aria-label="QR code for the phone link" hidden></canvas>
          <div class="phone-pair__qr phone-pair__qr--text" data-phone-qr-text aria-hidden="true">PHONE LINK</div>
          <div class="phone-pair__link" data-phone-link></div>
          <div class="lobby__status" data-phone-status role="status" aria-live="polite">Opening a phone room…</div>
          <div class="phone-pair__actions">
            <button class="key" data-phone-copy><b>⧉</b>Copy phone link</button>
            <button class="key" data-phone-cancel><b>×</b>Cancel</button>
          </div>
          <div class="phone-pair__cv" data-phone-cv role="status" aria-live="polite">Keep the marker board visible to this computer camera.</div>
        </div>
        <div class="prompt blink">↑ ↓ SELECT · ENTER START</div>
      </div>

      <div class="hint">
        <b>Esc</b> back &nbsp;·&nbsp; <b>L</b> scores<br />
        <span data-menu-note></span>
      </div>
    `;
    document.body.appendChild(el);
    this.menu = el;
    this.list = el.querySelector('[data-list]');
    this._screens = {
      game: el.querySelector('[data-screen="game"]'),
      play: el.querySelector('[data-screen="play"]'),
    };
    this._crumbGame = el.querySelector('[data-crumb-game]');
    this._screen = 'game';
    this._productChoices = ['tournament', 'friend', 'bot', 'fly', 'drills', 'coach'];
    this._gameIndex = 0;
    el.querySelector('[data-back]').onclick = () => this.setScreen('game');

    for (const btn of el.querySelectorAll('[data-game]')) {
      btn.onclick = () => this.chooseGame(btn.dataset.game);
    }

    this.lobby = el.querySelector('[data-lobby]');
    this.lobbyCode = el.querySelector('[data-lobby-code]');
    this.lobbyStatus = el.querySelector('[data-lobby-status]');
    this.lobbyDispute = el.querySelector('[data-lobby-dispute]');
    this.lobbyDispute.onclick = () => this.onTournamentDispute?.();
    this.lobbyRoster = el.querySelector('[data-lobby-roster]');
    this.lobbyShare = el.querySelector('[data-lobby-share]');
    this.lobbyLink = el.querySelector('[data-lobby-link]');
    el.querySelector('[data-lobby-host]').onclick = () => this._hostMatch();
    el.querySelector('[data-lobby-join]').onclick = () => this._joinMatch();
    this.lobbyStart = el.querySelector('[data-lobby-start]');
    this.lobbyStart.onclick = () => this._startTournament();
    el.querySelector('[data-lobby-copy]').onclick = () => this._copyRoomLink();
    el.querySelector('[data-lobby-leave]').onclick = () => this._leaveMatch();
    this.lobbyPhone = el.querySelector('[data-lobby-phone]');
    this.phonePair = el.querySelector('[data-phone-pair]');
    this.phoneQr = el.querySelector('[data-phone-qr]');
    this.phoneQrText = el.querySelector('[data-phone-qr-text]');
    this.phoneLink = el.querySelector('[data-phone-link]');
    this.phoneStatus = el.querySelector('[data-phone-status]');
    this.phoneCvStatus = el.querySelector('[data-phone-cv]');
    this.phonePair.querySelector('[data-phone-copy]').onclick = () => this._copyPhoneLink();
    this.phonePair.querySelector('[data-phone-cancel]').onclick = () => this._cancelPhonePair();
    el.querySelector('[data-lobby-invite]').onclick = () => this._sendLinqInvite();
    this.lobbyPhone.onkeydown = (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') this._sendLinqInvite();
    };
    // Typing a code and pressing enter joins, which is what everyone tries.
    this.lobbyCode.onkeydown = (e) => {
      e.stopPropagation(); // the menu's arrow/enter handling isn't wanted here
      if (e.code === 'Enter') this._joinMatch();
    };

    // The input picker is also the XR session picker. Keep AR and VR as
    // separate entries so passthrough is not silently replaced by full VR.
    this._entries = [
      { id: 'ar', label: 'In my room', note: 'headset · passthrough', disabled: true },
      { id: 'vr', label: 'In the arena', note: 'headset · full VR', disabled: true },
      { id: 'camera', label: 'A ping pong paddle', note: 'webcam', disabled: false },
      { id: 'camera-hand', label: 'A hand', note: 'webcam · hand tracking', disabled: false },
      { id: 'phone', label: 'A phone', note: 'motion + haptics', disabled: false },
      { id: 'desktop', label: 'Nothing — just the mouse', note: '', disabled: false },
    ];
    this._renderMenu();
    this._setProductCursor(this._gameIndex, false);
  }

  // The menu is two screens shown one after the other — pick a game, then
  // pick how to play it — the way a cabinet asks one question at a time.
  // One screen with both questions on it meant nobody read the second one.
  setScreen(name) {
    this._screen = name;
    this._screens.game.hidden = name !== 'game';
    this._screens.play.hidden = name !== 'play';
    if (name === 'play') {
      this._crumbGame.textContent = this._productLabel(this._productMode);
      // Land the cursor on something you can actually press Enter on —
      // carrying over a selection parked on a greyed-out headset row made
      // Enter silently do nothing.
      if (this._entries[this._selected]?.disabled) {
        const first = this._entries.findIndex((entry) => !entry.disabled);
        if (first >= 0) this._selected = first;
        this._renderMenu();
      }
    }
  }

  // Choosing a game answers screen one, so it also turns the page.
  chooseGame(value) {
    this._setProductCursor(this._productChoices.indexOf(value), false);
    this._productMode = value;
    if (value === 'tournament') {
      this.setGame('tournament');
      const rallyIndex = MODES.findIndex((mode) => mode.type === 'rally');
      if (rallyIndex >= 0) this.machine.modeIndex = rallyIndex;
    } else if (value === 'friend') {
      this.setGame('versus');
    } else if (value === 'coach') {
      // Coach owns its lesson ball and scenario, so do not change the
      // machine drill or opponent difficulty on the way in.
      this.setGame('coach');
    } else {
      this.setGame('arcade');
      this.settings.set('difficulty', value === 'fly' ? 'fly' : 'normal');
      const modeType = value === 'drills' ? 'drill' : 'rally';
      const modeIndex = MODES.findIndex((mode) => mode.type === modeType);
      if (modeIndex >= 0) this.machine.modeIndex = modeIndex;
    }
    this.setScreen('play');
  }

  _productLabel(value) {
    return {
      friend: 'PLAY A FRIEND',
      bot: 'PLAY A STANDARD BOT',
      fly: 'PLAY A FLY',
      drills: 'DRILLS',
      coach: 'COACH',
      tournament: 'CREATE A TOURNAMENT',
    }[value] ?? 'PLAY A STANDARD BOT';
  }

  _setProductCursor(index, sound = true) {
    if (index < 0) return;
    this._gameIndex = index;
    for (const btn of this.menu.querySelectorAll('[data-game]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.game === this._productChoices[index]));
    }
    if (sound) this.sfx.ui();
  }

  // Arcade is the drills and rally; Coach teaches one stroke at a time. It
  // is a separate game rather than another drill in the rotation, so it is
  // chosen here before you enter rather than cycled into by accident.
  setGame(value) {
    this.settings.set('game', value);
    this._syncGamePick();
    this.sfx.ui();
  }

  _syncGamePick() {
    const game = this.settings.get('game');
    const versus = game === 'versus';
    const tournament = game === 'tournament';
    this.lobby.hidden = !versus && !tournament;

    const hostButton = this.menu.querySelector('[data-lobby-host]');
    const joinButton = this.menu.querySelector('[data-lobby-join]');
    const lobbyOr = this.menu.querySelector('.lobby__or');
    if (tournament) {
      hostButton.innerHTML = '<b>▸</b>Create bracket room';
      joinButton.innerHTML = '<b>▸</b>Join bracket';
      lobbyOr.textContent = 'or join one';
      this.lobbyRoster.hidden = !this._tournament;
      if (!this._tournament) {
        this._setLobbyStatus(
          this.realtimeAvailable
            ? 'Create or join a four-player room. The host starts the bracket when all four arrive.'
            : this._realtimeSetupMessage('tournament')
        );
      }
      this._syncTournamentStartButton();
    } else {
      hostButton.innerHTML = '<b>▸</b>Start a room';
      joinButton.innerHTML = '<b>▸</b>Join';
      lobbyOr.textContent = 'or join one';
      this.lobbyStart.hidden = true;
      this.lobbyRoster.hidden = true;
      if (versus && !this._versus) {
        this._setLobbyStatus(
          this.realtimeAvailable
            ? 'Host a match, or enter a friend’s code.'
            : this._realtimeSetupMessage('versus')
        );
      }
    }

    // Backing out of a lobby should not leave any transport open behind it.
    if (!versus && this._versus) this._leaveMatch();
    if (!tournament && this._tournament) this._leaveTournament();
  }

  // --- Versus lobby -----------------------------------------------------

  // Which pipe the room is actually using. Worth saying out loud: the three
  // reach different distances, and "nothing happens" usually turns out to be
  // two players on two different ones.
  _transportNote() {
    const kind = this._versus?.kind;
    if (kind === 'local') {
      return 'Same-browser fallback: this build needs Supabase Realtime before another device can join.';
    }
    if (kind === 'webrtc') return 'Connected directly over WebRTC.';
    // The direct link never opened — a strict network is in the way — and the
    // fallback is carrying the match. Worth saying, because it is the one case
    // where adding TURN would visibly sharpen the ball.
    if (kind === 'webrtc-relay') {
      return this.relayAvailable
        ? 'Relayed through the server — a direct link could not be opened on this network.'
        : 'Connected through the relay — playable, but a TURN server would make it direct.';
    }
    if (kind === 'websocket') return 'Connected over this Wi-Fi.';
    if (kind === 'supabase') return 'Connected over the internet.';
    return '';
  }

  _setLobbyStatus(text, tone = '') {
    this.lobbyStatus.textContent = text;
    this.lobbyStatus.dataset.tone = tone;
  }

  _realtimeSetupMessage(mode) {
    if (import.meta.env.DEV) {
      return mode === 'tournament'
        ? 'Create or join a four-player room on this Wi-Fi. Share the host’s LAN link; the host starts once all four arrive.'
        : 'Host a match, or enter a friend’s code. This development server can relay to devices on this Wi-Fi.';
    }
    return mode === 'tournament'
      ? 'This build has no Supabase Realtime configuration, so a tournament only works between tabs in this browser.'
      : 'This build has no Supabase Realtime configuration, so a friend match only works between tabs in this browser.';
  }

  async _hostMatch() {
    if (this.settings.get('game') === 'tournament') return this._hostTournament();
    if (this._versus) return;
    this.sfx.ui();
    this._setLobbyStatus('Opening room…');
    try {
      this._versus = await this.onVersusCreate?.();
      this.lobbyCode.value = this._versus.code;
      this.lobbyLink.textContent = this._versus.link;
      this.lobbyShare.hidden = false;
      this._setLobbyStatus(
        `Room ${this._versus.code} — waiting for your opponent. ` +
          `${this._shareInstruction()} ${this._transportNote()}`
      );
    } catch (err) {
      console.error('Failed to host a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not open a room.', 'bad');
    }
  }

  async _joinMatch() {
    if (this.settings.get('game') === 'tournament') return this._joinTournament();
    if (this._versus) return;
    const code = this.lobbyCode.value.trim().toUpperCase();
    if (!code) {
      this._setLobbyStatus('Enter the code your opponent gave you.', 'bad');
      return;
    }
    // Checked here so a typo reads as a typo. Left to the relay it came back
    // as "Invalid room join", which is true, unhelpful, and looks like the
    // game is broken rather than the code being wrong.
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      this._setLobbyStatus('Room codes are letters and numbers, six of them.', 'bad');
      return;
    }
    this.sfx.ui();
    this._setLobbyStatus(`Joining ${code}…`);
    try {
      this._versus = await this.onVersusJoin?.(code);
      this.lobbyShare.hidden = true;
      // Which side you ended up on is decided by who got there first, so say
      // so — otherwise the player who arrived first sits waiting for a serve
      // that is theirs to make.
      this._setLobbyStatus(
        this._versus.role === 'host'
          ? `Room ${code} — you got there first, so you serve. ${this._shareInstruction()} ${this._transportNote()}`
          : `Joined ${code} — waiting for the host to serve. ${this._transportNote()}`
      );
    } catch (err) {
      console.error('Failed to join a match', err);
      this._versus = null;
      this._setLobbyStatus(err.message ?? 'Could not join that room.', 'bad');
    }
  }

  // --- Tournament lobby ------------------------------------------------

  _tournamentTransportNote() {
    const kind = this._tournament?.kind;
    if (kind === 'supabase') return 'Bracket synced through Realtime.';
    if (kind === 'websocket') return 'Bracket synced over this Wi-Fi.';
    if (kind === 'local') return 'Local-only bracket — open it in four tabs on this device.';
    return '';
  }

  _shareInstruction() {
    const kind = this._versus?.kind;
    if (kind === 'websocket') {
      return 'Share the link exactly as shown while both devices are on this Wi-Fi.';
    }
    if (kind === 'webrtc' || kind === 'webrtc-relay' || kind === 'supabase') {
      return 'Share the link — your friend can open it from the deployed site on their own device.';
    }
    if (kind === 'local') {
      return 'This build only connects tabs in this browser; use a Supabase-configured deployed build for another device.';
    }
    return 'Share the room code or link with your opponent.';
  }

  _syncTournamentStartButton() {
    if (!this.lobbyStart) return;
    const room = this._tournament;
    const canStart = Boolean(
      room?.isHost &&
      room?.admitted !== false &&
      room?.players?.length === 4 &&
      !this._tournamentStarted
    );
    this.lobbyStart.hidden = !room?.isHost || this._tournamentStarted;
    this.lobbyStart.disabled = !canStart;
    if (!canStart && room?.isHost && !this._tournamentStarted) {
      this.lobbyStart.title = 'Four players are needed to start the bracket.';
    } else {
      this.lobbyStart.removeAttribute('title');
    }
  }

  updateTournamentLobby(update) {
    if (!update) return;
    this._tournament = { ...(this._tournament ?? {}), ...update };
    this._tournamentStarted = Boolean(update.started ?? this._tournamentStarted);
    const players = this._tournament.players ?? [];
    // The lobby states its own capacity rather than assuming a bracket size.
    const capacity = this._tournament.capacity ?? 4;
    const watchers = this._tournament.spectatorCount ?? 0;
    this.lobbyRoster.hidden = false;
    this.lobbyRoster.textContent = `Players (${players.length}/${capacity}): ${players
      .map((player) => player.name)
      .join(' · ') || 'Waiting for players'}${
      watchers ? ` · ${watchers} watching` : ''
    }`;
    this._syncTournamentStartButton();
    this.lobbyDispute.hidden = !this._tournament.dispute;

    if (this.settings.get('game') !== 'tournament') return;
    if (this._tournament.spectating) {
      // A late joiner watches rather than being turned away: the bracket is on
      // the same broadcast channel the players are already on.
      this._setLobbyStatus(
        `Room ${this._tournament.code} — the bracket is full, so you are watching. Scores update here as matches finish.`
      );
    } else if (!this._tournamentStarted) {
      const hostText = this._tournament.isHost
        ? `You are the host. Start the bracket when ${capacity} players have joined.`
        : `Waiting for the host to start once ${capacity} players have joined.`;
      this._setLobbyStatus(
        `Room ${this._tournament.code} — ${players.length}/${capacity} joined. ${hostText} ${this._tournamentTransportNote()}`
      );
    }
  }

  setTournamentMatch(match) {
    this._tournamentMatch = match ?? null;
    if (!match) return;
    this._tournamentStarted = true;
    const opponent = match.opponent?.name ?? 'your opponent';
    const label = match.round === 1 ? 'final' : 'semifinal';
    const text = `Your ${label} is ready against ${opponent}. Choose your controls to enter the table.`;
    if (this.menu.hidden) this.toast(text);
    else this._setLobbyStatus(text, 'good');
  }

  showTournamentWaiting(text) {
    this._tournamentMatch = null;
    if (this.menu.hidden) this.toast(text);
    else this._setLobbyStatus(text);
  }

  async _hostTournament() {
    if (this._tournament) return;
    this.sfx.ui();
    this._setLobbyStatus('Opening tournament room…');
    try {
      const room = await this.onTournamentCreate?.();
      this._tournament = room;
      this.lobbyCode.value = room.code;
      this.lobbyLink.textContent = room.link;
      this.lobbyShare.hidden = false;
      this.updateTournamentLobby(room);
    } catch (err) {
      console.error('Failed to host tournament', err);
      this._tournament = null;
      this._setLobbyStatus(err.message ?? 'Could not open a tournament room.', 'bad');
    }
  }

  async _joinTournament() {
    if (this._tournament) return;
    const code = this.lobbyCode.value.trim().toUpperCase();
    if (!code) {
      this._setLobbyStatus('Enter the tournament code your host gave you.', 'bad');
      return;
    }
    if (!/^[A-Z0-9]{4,12}$/.test(code)) {
      this._setLobbyStatus('Room codes are letters and numbers, six of them.', 'bad');
      return;
    }
    this.sfx.ui();
    this._setLobbyStatus(`Joining tournament ${code}…`);
    try {
      const room = await this.onTournamentJoin?.(code);
      this._tournament = room;
      this.lobbyShare.hidden = true;
      this.updateTournamentLobby(room);
    } catch (err) {
      console.error('Failed to join tournament', err);
      this._tournament = null;
      this._setLobbyStatus(err.message ?? 'Could not join that tournament.', 'bad');
    }
  }

  async _startTournament() {
    if (!this._tournament?.isHost || this._tournamentStarted) return;
    if (this._tournament.players?.length !== (this._tournament.capacity ?? 4)) {
      this._setLobbyStatus('Wait for all four bracket players before starting.', 'bad');
      return;
    }
    this.sfx.ui();
    this._setLobbyStatus('Seeding the bracket…');
    try {
      await this.onTournamentStart?.();
      this._tournamentStarted = true;
      this._syncTournamentStartButton();
    } catch (err) {
      console.error('Failed to start tournament', err);
      this._setLobbyStatus(err.message ?? 'Could not start the bracket.', 'bad');
    }
  }

  async _sendLinqInvite() {
    const phoneNumber = this.lobbyPhone.value.trim().replace(/[()\s-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      this._setLobbyStatus('Use an international number, for example +14165551234.', 'bad');
      return;
    }
    const roomLink = this.lobbyLink.textContent;
    if (!roomLink) return;
    this.sfx.ui();
    this._setLobbyStatus('Sending the iMessage invite…');
    try {
      await sendInvite(phoneNumber, roomLink);
      this._setLobbyStatus('Invite sent — they can tap the link to join.', 'good');
      this.toast('Invite sent');
    } catch (err) {
      console.error('Failed to send Linq invite', err);
      this._setLobbyStatus(err.message ?? 'Could not send the invite.', 'bad');
    }
  }

  async _copyRoomLink() {
    const link = this.lobbyLink.textContent;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.toast('Link copied');
    } catch {
      // Clipboard access is refused in plenty of contexts; the link is on
      // screen either way, so select it and let them copy it by hand.
      const range = document.createRange();
      range.selectNodeContents(this.lobbyLink);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.toast('Copy the highlighted link');
    }
  }

  _leaveMatch() {
    if (this.settings.get('game') === 'tournament') {
      this._leaveTournament();
      return;
    }
    this.onVersusLeave?.();
    this._versus = null;
    this.hideCoachPanel();
    this.lobbyShare.hidden = true;
    this.versusHud.hidden = true;
    this.hideCountdown();
    this._hideVersusWin();
    this._setLobbyStatus('Left the room.');
  }

  _leaveTournament() {
    this.onTournamentLeave?.();
    this._tournament = null;
    this._tournamentStarted = false;
    this._tournamentMatch = null;
    this._phoneReadyStarted = false;
    this.phonePair.hidden = true;
    this.lobbyShare.hidden = true;
    this.lobbyRoster.hidden = true;
    this.lobbyStart.hidden = true;
    this.hideCoachPanel();
    this.versusHud.hidden = true;
    this.hideCountdown();
    this._hideVersusWin();
    this._setLobbyStatus('Left the tournament room.');
  }

  // Whether a networked match is set up and ready to play.
  get inVersus() {
    return Boolean(this._versus);
  }

  _renderMenu() {
    this.list.innerHTML = '';
    this._entries.forEach((entry, i) => {
      const b = document.createElement('button');
      b.className = 'item';
      b.disabled = entry.disabled;
      b.setAttribute('aria-selected', String(i === this._selected));
      // Three columns, so the caret, the place and the caption line up down
      // the list instead of drifting with the length of each label.
      b.innerHTML =
        `<span class="item__caret">▸</span><span>${entry.label}</span>` +
        `<span class="item__note">${entry.note ?? ''}</span>`;
      b.onmouseenter = () => {
        this._selected = i;
        this._syncMenuSelection();
      };
      b.onclick = () => this._activateMenu(i);
      this.list.appendChild(b);
    });
  }

  _syncMenuSelection() {
    [...this.list.children].forEach((child, i) =>
      child.setAttribute('aria-selected', String(i === this._selected))
    );
  }

  _moveMenu(delta) {
    const n = this._entries.length;
    let next = this._selected;
    // Skip over unavailable entries so the caret never parks on a dead line
    for (let i = 0; i < n; i++) {
      next = (next + delta + n) % n;
      if (!this._entries[next].disabled) break;
    }
    this._selected = next;
    this._syncMenuSelection();
    this.sfx.ui();
  }

  _activateMenu(index) {
    const entry = this._entries[index];
    if (!entry || entry.disabled) return;
    if (entry.id === 'phone') {
      this.settings.set('paddleSource', 'phone');
      this._startPhonePair();
    } else if (entry.id === 'camera') {
      this.settings.set('paddleSource', 'camera');
      this._launch(null);
    } else if (entry.id === 'camera-hand') {
      this.settings.set('paddleSource', 'camera-hand');
      this._launch(null);
    } else if (entry.id === 'desktop') {
      // On desktop, the controller source falls back to the mouse. Do not
      // reuse a saved webcam/hand selection when Computer was requested.
      this.settings.set('paddleSource', 'controller');
      this._launch(null);
    } else if (entry.id === 'ar') {
      this._launch('immersive-ar');
    } else if (entry.id === 'vr') {
      this._launch('immersive-vr');
    }
  }

  applyXRSupport(support) {
    const ar = this._entries.find((entry) => entry.id === 'ar');
    const vr = this._entries.find((entry) => entry.id === 'vr');
    ar.disabled = !support['immersive-ar'];
    vr.disabled = !support['immersive-vr'];
    ar.note = support['immersive-ar'] ? 'headset · passthrough' : 'needs an AR headset';
    vr.note = support['immersive-vr'] ? 'headset · full VR' : 'needs a VR headset';
    const menuNote = this.menu.querySelector('[data-menu-note]');
    menuNote.textContent = support['immersive-ar'] || support['immersive-vr']
      ? 'Headset ready'
      : 'Open this page in the Meta Quest Browser to play in a headset';
    this._selected = this._entries.findIndex((entry) => !entry.disabled);
    if (this._selected < 0) this._selected = 0;
    this._renderMenu();
  }

  async _startPhonePair() {
    if (this.phonePair.hidden === false) return;
    this._phoneReadyStarted = false;
    this.phonePair.hidden = false;
    this.phoneStatus.textContent = 'Opening a phone room…';
    this.phoneStatus.dataset.tone = '';
    this.phoneCvStatus.textContent = 'Waiting for the desktop camera and phone connection.';
    this.phoneCvStatus.dataset.tone = '';
    this.phoneLink.textContent = '';
    if (this.phoneQr) {
      this.phoneQr.hidden = true;
      const ctx = this.phoneQr.getContext?.('2d');
      if (ctx) ctx.clearRect(0, 0, this.phoneQr.width, this.phoneQr.height);
    }
    if (this.phoneQrText) {
      this.phoneQrText.hidden = false;
      this.phoneQrText.textContent = 'GENERATING QR…';
    }
    try {
      const result = await this.onPhonePair?.();
      if (!result?.link) throw new Error('Could not create the phone pairing link.');
      this.phoneLink.textContent = result.link;
      this.phoneStatus.textContent = `Room ${result.code} · scan QR or open the link on your phone.`;
      this.phoneStatus.dataset.tone = 'good';
      await this._renderPhoneQr(result.link);
    } catch (error) {
      this.phoneStatus.textContent = error?.message || 'Phone pairing could not start.';
      this.phoneStatus.dataset.tone = 'bad';
      if (this.phoneQrText) {
        this.phoneQrText.hidden = false;
        this.phoneQrText.textContent = 'QR UNAVAILABLE — USE LINK';
      }
    }
  }

  async _renderPhoneQr(link) {
    if (!this.phoneQr) return;
    try {
      const QRCode = (await import('qrcode')).default;
      const canvas = this.phoneQr;
      await QRCode.toCanvas(canvas, link, {
        width: 168,
        margin: 1,
        color: { dark: '#0b0b0c', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
      canvas.hidden = false;
      if (this.phoneQrText) this.phoneQrText.hidden = true;
    } catch {
      if (this.phoneQrText) {
        this.phoneQrText.hidden = false;
        this.phoneQrText.textContent = 'COPY LINK BELOW';
      }
    }
  }

  setPhoneStatus(text, tone = '') {
    if (!this.phoneStatus) return;
    this.phoneStatus.textContent = text;
    this.phoneStatus.dataset.tone = tone;
  }

  async _copyPhoneLink() {
    const link = this.phoneLink.textContent;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.phoneStatus.textContent = 'Phone link copied.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.phoneLink);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      this.phoneStatus.textContent = 'Select the highlighted link to copy it.';
    }
  }

  _cancelPhonePair() {
    this.phonePair.hidden = true;
    this.onExit?.();
    this.settings.set('paddleSource', 'controller');
  }

  phoneCvReady() {
    this.phoneCvStatus.textContent = 'Camera locked on the phone marker board.';
    this.phoneCvStatus.dataset.tone = 'good';
  }

  phoneCvWaiting() {
    this.phoneCvStatus.textContent = 'Keep the phone marker board visible to this computer camera.';
  }

  phoneDisconnected() {
    this.phoneStatus.textContent = 'Phone disconnected · reconnect the phone link.';
    this.phoneStatus.dataset.tone = 'bad';
  }

  phoneReady() {
    if (this._phoneReadyStarted) return;
    this._phoneReadyStarted = true;
    this.phoneStatus.textContent = 'Phone confirmed · entering the arena…';
    this.phonePair.hidden = true;
    this._launch(null);
  }

  async _launch(mode) {
    // Versus has nothing to play until a room exists, and walking into an
    // empty table wondering where the ball is would be a worse answer than
    // saying so.
    if (this.settings.get('game') === 'versus' && !this._versus) {
      this._setLobbyStatus('Host a match or join a code first.', 'bad');
      this.sfx.ui(false);
      return;
    }

    this.sfx.unlock(); // first user gesture — the only moment audio can start
    this.sfx.ui();
    if (this.settings.get('game') === 'tournament') {
      if (!this._tournament || !this._tournamentStarted) {
        this._setLobbyStatus('Create or join a bracket room, then wait for the host to start it.', 'bad');
        this.sfx.ui(false);
        return;
      }
      if (!this._tournamentMatch) {
        this._setLobbyStatus('Your next bracket match is not ready yet.', 'bad');
        this.sfx.ui(false);
        return;
      }
      try {
        const ready = await this.onTournamentLaunch?.(this._tournamentMatch);
        if (ready === false) return;
      } catch (err) {
        console.error('Failed to enter tournament match', err);
        this._setLobbyStatus(err.message ?? 'Could not enter your bracket match.', 'bad');
        return;
      }
    }

    this.menu.hidden = true;
    this.bar.hidden = false;
    this.onStart?.(mode);

    if (mode) {
      try {
        await this.xr.start(mode);
      } catch (err) {
        console.error('Failed to start XR session', err);
        this.toast('Headset session failed');
        this.showMenu();
      }
    }
  }

  showMenu() {
    this.menu.hidden = false;
    if (this._screens) this.setScreen('game');
    if (this.bar) this.bar.hidden = true;
    if (this.settingsEl) this.settingsEl.hidden = true;
    if (this.tournamentHud) this.tournamentHud.hidden = true;
  }

  // --- Coaching panel --------------------------------------------------

  _buildCoachPanel() {
    const el = document.createElement('aside');
    el.id = 'coach-panel';
    el.hidden = true;
    el.setAttribute('aria-label', 'Coaching');
    // The status line and the feedback line change while you play, with no
    // interaction of your own to trigger them — exactly what a live region is
    // for. The score and metrics repaint far too often to announce.
    el.innerHTML = `
      <div class="coach-panel__head">
        <span>COACH</span>
        <span data-coach-status role="status" aria-live="polite">LOCAL</span>
        <span class="coach-panel__controls">
          <button data-coach-audio aria-label="Toggle coaching narration"></button>
          <button data-coach-voice aria-label="Change narrator"></button>
        </span>
      </div>
      <div class="coach-panel__scenario" data-coach-scenario>Ready</div>
      <div class="coach-panel__score" data-coach-score>--%</div>
      <div class="coach-panel__metrics" data-coach-metrics></div>
      <div class="coach-panel__feedback" data-coach-feedback role="status" aria-live="polite">Complete a stroke to get feedback.</div>
      <div class="coach-panel__summary" data-coach-summary hidden></div>
    `;
    document.body.appendChild(el);
    this.coachPanel = el;
    this.coachScenario = el.querySelector('[data-coach-scenario]');
    this.coachScore = el.querySelector('[data-coach-score]');
    this.coachMetrics = el.querySelector('[data-coach-metrics]');
    this.coachFeedback = el.querySelector('[data-coach-feedback]');
    this.coachSummary = el.querySelector('[data-coach-summary]');
    this.coachStatus = el.querySelector('[data-coach-status]');
    this.coachAudio = el.querySelector('[data-coach-audio]');
    this.coachVoice = el.querySelector('[data-coach-voice]');
    this.coachAudio.onclick = () => {
      const settings = getNarrationSettings();
      setNarrationEnabled(!settings.enabled);
      this._updateNarrationControls();
    };
    this.coachVoice.onclick = () => {
      const mode = getNarrationSettings().mode;
      const next = mode === 'auto' ? 'a' : mode === 'a' ? 'b' : 'auto';
      setNarratorMode(next);
      this._updateNarrationControls();
    };
    this._updateNarrationControls();
  }

  _updateNarrationControls() {
    const { enabled, mode } = getNarrationSettings();
    if (this.coachAudio) {
      this.coachAudio.textContent = enabled ? '🔊' : '🔇';
      this.coachAudio.title = enabled ? 'Mute coaching narration' : 'Enable coaching narration';
      this.coachAudio.setAttribute('aria-pressed', String(enabled));
    }
    if (this.coachVoice) {
      const label = mode === 'auto' ? 'AUTO' : `VOICE ${mode.toUpperCase()}`;
      this.coachVoice.textContent = label;
      this.coachVoice.title = 'Cycle narrator: auto, narrator A, narrator B';
      // The visible label is an abbreviation, so give the button the sentence.
      this.coachVoice.setAttribute('aria-label', `Change narrator, currently ${label}`);
    }
  }

  // The coach is a live companion in every game, not just guided lessons.
  // Showing a clear Ready state before the first ball makes its availability
  // obvious in ordinary drills, bot play, and tournaments.
  showCoachReady(label = 'Live coaching ready') {
    if (!this.coachPanel) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = label;
    this.coachScore.textContent = 'READY';
    this.coachMetrics.textContent = 'LIVE TELEMETRY ARMED';
    this.coachFeedback.textContent = 'Hit a ball for a precise technique correction.';
    this.coachSummary.hidden = true;
    this.setCoachProfileStatus('LIVE');
  }

  // Ordinary rally contacts do not have a prescribed path, so expose the
  // measurable stroke qualities instead of pretending they are drill scores.
  showLiveCoachShot(shot = {}) {
    if (!this.coachPanel) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = shot.label || 'Live stroke';
    this.coachScore.textContent = `${Math.round(shot.total ?? 0)}%`;
    this.coachMetrics.textContent =
      `PACE ${Math.round(shot.pace ?? 0)} · ` +
      `DEPTH ${Math.round(shot.depth ?? 0)} · ` +
      `FACE ${Math.round(shot.face ?? 0)} · ` +
      `SPIN ${Math.round(shot.spin ?? 0)}`;
    this.coachFeedback.textContent = shot.note || 'Reading this stroke…';
    this.coachSummary.hidden = true;
    this.setCoachProfileStatus('ANALYZING');
  }

  showCoachScore(score, scenario = '') {
    if (!this.coachPanel) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = scenario ? scenario.replaceAll('-', ' ') : 'Coached stroke';
    this.coachScore.textContent = `${score?.total ?? 0}%`;
    this.coachMetrics.textContent = score
      ? `PATH ${score.path ?? 0} · SYNC ${score.sync ?? 0} · FACE ${score.face ?? 0} · TIME ${score.timing ?? 0}`
      : '';
    this.coachFeedback.textContent = score?.note || 'Feedback pending…';
    this.coachSummary.hidden = true;
  }

  showCoachFeedback(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachFeedback.textContent = text;
  }

  showMatchSummary(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = 'Post-match summary';
    this.coachSummary.hidden = false;
    this.coachSummary.textContent = text;
  }

  showProfileSummary(text) {
    if (!this.coachPanel || !text) return;
    this.coachPanel.hidden = false;
    this.coachScenario.textContent = 'Your recurring trends';
    this.coachSummary.hidden = false;
    this.coachSummary.textContent = text;
  }

  setCoachProfileStatus(status) {
    if (this.coachStatus) this.coachStatus.textContent = status;
  }

  hideCoachPanel() {
    if (this.coachPanel) this.coachPanel.hidden = true;
  }

  // --- Bottom status line ----------------------------------------------

  _buildBar() {
    const el = document.createElement('div');
    el.id = 'bar';
    el.innerHTML = `
      <span class="bar__mode" data-bar-mode>—</span>
      <span class="bar__stats" data-bar-stats>—</span>
      <span class="bar__spacer"></span>
      <button class="key" data-act="toggle"><b>Space</b><span data-toggle-label>Pause</span></button>
      <button class="key" data-act="mode"><b>D</b>Mode</button>
      <button class="key" data-act="serve"><b>S</b>Serve</button>
      <button class="key" data-act="settings"><b>Tab</b>Settings</button>
      <button class="key" data-act="exit"><b>Esc</b>Menu</button>
    `;
    document.body.appendChild(el);
    this.bar = el;

    el.querySelector('[data-act="toggle"]').onclick = () => this.togglePause();
    el.querySelector('[data-act="mode"]').onclick = () => this.nextMode();
    el.querySelector('[data-act="serve"]').onclick = () => this.serveOne();
    el.querySelector('[data-act="settings"]').onclick = () => this.toggleSettings();
    el.querySelector('[data-act="exit"]').onclick = () => this.quitToMenu();
  }

  // --- Settings ---------------------------------------------------------

  _buildSettings() {
    const el = document.createElement('div');
    el.id = 'settings';
    el.hidden = true;
    // Same contract as the start menu: a full-screen overlay that traps the
    // player's attention is a dialog, and has to say so to be usable without
    // sight of it.
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Settings');
    el.innerHTML = `
      <button class="key settings__close" data-settings-close aria-label="Close settings">
        <b>×</b><span>Close</span>
      </button>
      <div class="settings__title">Settings</div>
      <div class="settings__list" data-rows></div>
      <div class="hint">Tab / Esc to close</div>
    `;
    document.body.appendChild(el);
    this.settingsEl = el;
    this.rows = el.querySelector('[data-rows]');
    el.querySelector('[data-settings-close]').onclick = () => this.toggleSettings(false);
  }

  _renderSettings() {
    const items = this._menuItems().filter(
      (i) => i.kind !== 'action' || i.id === 'reset'
    );
    this.rows.innerHTML = '';

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'row';

      if (item.kind === 'action') {
        row.innerHTML = `<button class="key"><b>▸</b>${item.label}</button><span></span>`;
        row.querySelector('button').onclick = () => {
          item.activate();
          this.sfx.ui();
          this.toast(item.label);
        };
      } else {
        row.innerHTML = `
          <span class="row__label">${item.label}</span>
          <span class="row__value">
            <button class="arrow" data-d="-1">‹</button>
            <span class="row__current">${item.value}</span>
            <button class="arrow" data-d="1">›</button>
          </span>
        `;
        row.querySelectorAll('.arrow').forEach((b) => {
          b.onclick = () => {
            item.step(Number(b.dataset.d));
            this.sfx.ui();
            this._renderSettings();
          };
        });
      }
      this.rows.appendChild(row);
    }
  }

  _menuItems() {
    return buildPauseMenu({
      inXR: Boolean(this.xr.session),
      machine: this.machine,
      game: this.game,
      settings: this.settings,
      onResume: () => this.toggleSettings(false),
      onRecenter: () => this.onRecenter?.(),
      onExit: () => this.quitToMenu(),
    });
  }

  // --- Commands (shared by clicks, keys and the VR menu) ----------------

  // The bottom bar's commands drive the ball machine, and the machine only
  // runs in Arcade. Coach places its own balls and Versus is fed by the other
  // player, so these have to be refused rather than quietly doing something —
  // pressing S in a match used to fire a stray ball into it that only one
  // side could see, and D silently rotated a drill you would meet again the
  // next time you played Arcade.
  _machineCommandsAllowed(what) {
    const game = this.settings.get('game');
    if (game === 'arcade') return true;
    const label = game === 'versus' ? 'a match' : game === 'tournament' ? 'a tournament' : 'Coach';
    this.toast(`No ${what} in ${label}`);
    this.sfx.ui(false);
    return false;
  }

  togglePause() {
    if (!this._machineCommandsAllowed('pausing')) return;
    this.machine.enabled = !this.machine.enabled;
    this.game.revision++;
    this.sfx.ui(this.machine.enabled);
    this.toast(this.machine.enabled ? 'Armed' : 'Paused');
  }

  nextMode() {
    if (!this._machineCommandsAllowed('mode change')) return;
    const mode = this.machine.nextDrill();
    this.game.revision++;
    this.sfx.ui();
    this.toast(mode.name);
  }

  serveOne() {
    if (!this._machineCommandsAllowed('serving')) return;
    this.machine.serve();
  }

  toggleSettings(force) {
    const open = force ?? this.settingsEl.hidden;
    this.settingsEl.hidden = !open;
    if (open) this._renderSettings();
    this.sfx.ui(open);
  }

  quitToMenu() {
    this.hideCoachPanel();
    // Record before tearing anything down — onExit resets the match state
    // this reads from.
    this.recordRun?.(this.onRunSummary?.() ?? {});
    this.settingsEl.hidden = true;
    this.scoresEl.hidden = true;
    this.versusHud.hidden = true;
    this.tournamentHud.hidden = true;
    this.hideCountdown();
    this._hideVersusWin();
    this._versus = null;
    this._tournament = null;
    this._tournamentStarted = false;
    this._tournamentMatch = null;
    this._phoneReadyStarted = false;
    this.phonePair.hidden = true;
    this.lobbyShare.hidden = true;
    this.lobbyRoster.hidden = true;
    this.lobbyStart.hidden = true;
    this.xr.end();
    this.onExit?.(); // also closes the room, via main
    this.showMenu();
  }

  // --- Keyboard ---------------------------------------------------------

  _onKey(e) {
    if (!this.menu.hidden) {
      if (document.activeElement === this.lobbyCode) return; // typing a code

      // The scores panel covers the menu, so it takes the keyboard with it.
      // Without this, Enter started the game behind it — you ended up playing
      // under a leaderboard — and the number keys changed a game you could
      // not see.
      if (!this.scoresEl.hidden) {
        if (e.code === 'KeyL' || e.code === 'Escape' || e.code === 'Enter') {
          e.preventDefault();
          this.toggleScores(false);
        }
        return;
      }

      if (e.code === 'Digit1') this.chooseGame('tournament');
      else if (e.code === 'Digit2') this.chooseGame('friend');
      else if (e.code === 'Digit3') this.chooseGame('bot');
      else if (e.code === 'Digit4') this.chooseGame('fly');
      else if (e.code === 'Digit5') this.chooseGame('drills');
      else if (e.code === 'Digit6') this.chooseGame('coach');
      else if (e.code === 'KeyL') this.toggleScores();
      else if (e.code === 'Escape' || e.code === 'Backspace') {
        if (this._screen === 'play') this.setScreen('game');
      } else if (this._screen === 'game') {
        // Product choices map onto game settings, so their cursor must be
        // separate from the underlying Arcade/Versus setting.
        const games = this._productChoices;
        if (e.code === 'ArrowUp') this._setProductCursor((this._gameIndex + games.length - 1) % games.length);
        else if (e.code === 'ArrowDown') this._setProductCursor((this._gameIndex + 1) % games.length);
        else if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          this.chooseGame(games[this._gameIndex]);
        }
      } else if (e.code === 'ArrowUp') this._moveMenu(-1);
      else if (e.code === 'ArrowDown') this._moveMenu(1);
      else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this._activateMenu(this._selected);
      }
      return;
    }

    if (this.isInputBlocked()) return; // the in-headset menu has the floor

    if (e.code === 'Escape') {
      if (!this.settingsEl.hidden) this.toggleSettings(false);
      else this.quitToMenu();
    } else if (e.code === 'Tab') {
      e.preventDefault();
      this.toggleSettings();
    } else if (e.code === 'Space') {
      e.preventDefault();
      this.togglePause();
    } else if (e.code === 'KeyD') {
      this.nextMode();
    } else if (e.code === 'KeyS') {
      this.serveOne();
    } else if (e.code === 'KeyR') {
      this.game.reset();
      this.toast('Score reset');
    } else if (e.code === 'KeyC') {
      this.onRecenter?.();
    }
  }

  // --- Tournament and versus HUD ---------------------------------------

  _buildTournamentHud() {
    const el = document.createElement('aside');
    el.id = 'tournament-hud';
    el.hidden = true;
    el.setAttribute('aria-label', 'Tournament progress');
    el.innerHTML = `
      <div class=tournament__title>TOURNAMENT</div>
      <div data-tournament-round role="status" aria-live="polite"></div>
      <pre data-tournament-bracket aria-label="Bracket"></pre>
      <div data-tournament-score role="status" aria-live="polite"></div>
    `;
    document.body.appendChild(el);
    this.tournamentHud = el;
    this.tournamentRound = el.querySelector('[data-tournament-round]');
    this.tournamentBracket = el.querySelector('[data-tournament-bracket]');
    this.tournamentScore = el.querySelector('[data-tournament-score]');
  }

  updateTournament(snapshot) {
    if (!snapshot || !this.tournamentHud) return;
    this._tournamentSnapshot = snapshot;
    this.tournamentHud.hidden = false;
    const nameFor = (player) => player?.name ?? player ?? 'TBD';
    const localId = this._tournament?.player?.id;
    const activeMatch = snapshot.matches.find(
      (match) =>
        !match.winnerId &&
        (match.player1?.id === localId || match.player2?.id === localId)
    ) ?? snapshot.matches.find((match) => !match.winnerId && match.player1 && match.player2);
    const champion = snapshot.players?.find((player) => player.id === snapshot.championId);
    this.tournamentRound.textContent = snapshot.finished
      ? (champion?.id === localId ? 'CHAMPION' : `CHAMPION: ${champion?.name ?? 'TBD'}`)
      : activeMatch
        ? `${activeMatch.round === 1 ? 'FINAL' : 'SEMIFINAL'} · FIRST TO ${snapshot.target}`
        : 'WAITING FOR BRACKET RESULT';
    this.tournamentScore.textContent = activeMatch
      ? `${nameFor(activeMatch.player1)} ${activeMatch.score1} — ${activeMatch.score2} ${nameFor(activeMatch.player2)}`
      : '';
    this.tournamentBracket.textContent = snapshot.matches
      .map((match) => {
        const round = match.round === 1 ? 'FINAL' : `SEMIFINAL ${match.slot + 1}`;
        const winner = match.winnerId
          ? `  ✓ ${nameFor(match.player1?.id === match.winnerId ? match.player1 : match.player2)}`
          : '';
        return `${round}\n${nameFor(match.player1)} ${match.score1} — ${match.score2} ${nameFor(match.player2)}${winner}`;
      })
      .join('\n\n');
  }

  // --- Versus HUD -------------------------------------------------------
  //
  // The in-world scoreboard carries the match too, but a headset is not the
  // only way to play this: on a screen the flat overlay is the scoreboard.

  _buildVersusHud() {
    const el = document.createElement('div');
    el.id = 'versus';
    el.hidden = true;
    el.innerHTML = `
      <div class="versus__score">
        <span class="versus__side" data-versus-you>You <b>0</b></span>
        <span class="versus__dash">—</span>
        <span class="versus__side" data-versus-them><b>0</b> Them</span>
      </div>
      <div class="versus__state" data-versus-state role="status" aria-live="polite">Waiting for opponent</div>
    `;
    document.body.appendChild(el);
    this.versusHud = el;

    this.countdownEl = document.createElement('div');
    this.countdownEl.id = 'countdown';
    this.countdownEl.hidden = true;
    document.body.appendChild(this.countdownEl);

    this.winEl = document.createElement('div');
    this.winEl.id = 'versus-win';
    this.winEl.hidden = true;
    this.winEl.setAttribute('role', 'dialog');
    this.winEl.setAttribute('aria-modal', 'true');
    this.winEl.setAttribute('aria-label', 'Match result');
    this.winEl.innerHTML = `
      <div class="win__result" data-win-result role="status" aria-live="polite">You win</div>
      <div class="win__score" data-win-score></div>
      <button class="key" data-win-exit><b>Esc</b>Back to menu</button>
    `;
    document.body.appendChild(this.winEl);
    this.winEl.querySelector('[data-win-exit]').onclick = () => this.quitToMenu();
  }

  // Force the line under the score to say something specific — used when the
  // room dies, where "waiting for opponent" would be a lie.
  setVersusState(text) {
    this.versusHud.hidden = false;
    const state = this.versusHud.querySelector('[data-versus-state]');
    state.textContent = text;
    state.dataset.live = 'false';
  }

  setVersusOpponent(present) {
    this.versusHud.hidden = false;
    const state = this.versusHud.querySelector('[data-versus-state]');
    state.textContent = present ? 'Opponent connected' : 'Waiting for opponent';
    state.dataset.live = String(present);
    if (present && !this.menu.hidden) this._setLobbyStatus('Opponent connected — start when ready.');
    else if (!present && this._versus) this._setLobbyStatus('Opponent left the room.');
  }

  // `snap` is a VersusMatch snapshot; `role` is which side this browser is.
  updateVersusScore(snap, role) {
    this.versusHud.hidden = false;
    const you = role === 'guest' ? snap.scoreGuest : snap.scoreHost;
    const them = role === 'guest' ? snap.scoreHost : snap.scoreGuest;
    this.versusHud.querySelector('[data-versus-you] b').textContent = String(you);
    this.versusHud.querySelector('[data-versus-them] b').textContent = String(them);
    const serving = snap.server === role;
    this.versusHud.querySelector('[data-versus-state]').textContent = snap.winner
      ? 'Match over'
      : serving
        ? 'Your serve'
        : 'Their serve';
  }

  showCountdown(seconds) {
    this.countdownEl.hidden = false;
    this.countdownEl.textContent = String(seconds);
  }

  hideCountdown() {
    if (this.countdownEl) this.countdownEl.hidden = true;
  }

  showVersusWin(youWon, snap) {
    if (!this.winEl.hidden) return; // already showing; don't restart it
    this.hideCountdown();
    this.winEl.hidden = false;
    this.winEl.querySelector('[data-win-result]').textContent = youWon
      ? 'You win'
      : 'You lose';
    this.winEl.querySelector('[data-win-result]').dataset.won = String(youWon);
    this.winEl.querySelector('[data-win-score]').textContent =
      `${snap.scoreHost} — ${snap.scoreGuest}`;
    this.sfx.ui(youWon);
  }

  _hideVersusWin() {
    if (this.winEl) this.winEl.hidden = true;
  }

  // --- Webcam preview ---------------------------------------------------
  //
  // Colour tracking fails for reasons you can see instantly and cannot guess
  // at all: it locked onto a red jumper, the rubber is in shadow, your hand is
  // over the face. A thumbnail of what the camera is matching turns "it
  // doesn't work" into "move the lamp".

  _buildCamPreview() {
    const el = document.createElement('div');
    el.id = 'campreview';
    el.hidden = true;
    // A bare <canvas> is invisible to assistive tech, and this one is the only
    // confirmation that the camera found the paddle.
    el.innerHTML = `
      <canvas class="campreview__view" width="192" height="144" role="img"
        aria-label="Camera preview of your paddle"></canvas>
      <div class="campreview__status" data-cam-status role="status" aria-live="polite"></div>
    `;
    document.body.appendChild(el);
    this.camPreview = el;
    this.camCanvas = el.querySelector('canvas');
    this.camStatus = el.querySelector('[data-cam-status]');
  }

  // `tracker` is a PaddleTracker, or null to put the preview away.
  showCamPreview(tracker) {
    if (!tracker) {
      this.camPreview.hidden = true;
      return null;
    }
    this.camPreview.hidden = false;
    tracker.attachDebugCanvas(this.camCanvas);
    return this.camCanvas;
  }

  setCamStatus(text) {
    if (this.camStatus) this.camStatus.textContent = text;
  }

  // --- Scores -----------------------------------------------------------
  //
  // One board per game, because the three ask completely different things of
  // you and a single number across them would mean nothing.

  _buildScores() {
    const el = document.createElement('div');
    el.id = 'scores';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Scores');
    el.innerHTML = `
      <div class="settings__title" data-scores-title>Scores</div>
      <div class="scores__name">
        <span class="row__label">Name</span>
        <input class="lobby__code scores__input" data-scores-name maxlength="24" autocomplete="off" />
      </div>
      <div class="scores__list" data-scores-list></div>
      <div class="hint">L / Esc to close</div>
    `;
    document.body.appendChild(el);
    this.scoresEl = el;
    this.scoresList = el.querySelector('[data-scores-list]');
    this.scoresName = el.querySelector('[data-scores-name]');
    this.scoresName.value = this.settings.get('playerName') ?? 'Player';
    this.scoresName.onkeydown = (e) => e.stopPropagation(); // typing, not commands
    this.scoresName.onchange = () =>
      this.settings.set('playerName', this.scoresName.value.trim() || 'Player');
  }

  async toggleScores(force) {
    const open = force ?? this.scoresEl.hidden;
    this.scoresEl.hidden = !open;
    this.sfx.ui(open);
    if (!open) return;

    const category = this.settings.get('game');
    this.scoresEl.querySelector('[data-scores-title]').textContent = `${category} scores`;
    this.scoresList.innerHTML = '<div class="row"><span class="row__label">Loading…</span></div>';

    const rows = await getLeaderboard(category);
    if (!rows.length) {
      this.scoresList.innerHTML =
        '<div class="row"><span class="row__label">No runs yet — play one</span></div>';
      return;
    }
    this.scoresList.innerHTML = rows
      .map(
        (row, i) => `
        <div class="row scores__row">
          <span class="row__label">${i + 1}. ${escapeHtml(row.player_name)}</span>
          <span class="row__value"><b>${row.score}</b></span>
        </div>`
      )
      .join('');
  }

  // Called when a run ends. Nothing is uploaded unless you actually played.
  async recordRun(summary) {
    const category = this.settings.get('game');
    if (!isWorthRecording(summary, category)) return;
    const name = this.settings.get('playerName') ?? 'Player';
    try {
      const entry = await submitScore(name, summary, category);
      this.toast(`Scored ${entry.score}`);
    } catch (err) {
      console.error('Could not record the run', err);
    }
  }

  // --- Toast ------------------------------------------------------------

  _buildToast() {
    this.toastEl = document.createElement('div');
    this.toastEl.id = 'toast';
    // Toasts are the running commentary — "armed", "connection lost", "scored
    // 840" — and they are gone in 1.3 seconds. Without a live region they are
    // invisible to anyone not watching that corner of the screen.
    this.toastEl.setAttribute('role', 'status');
    this.toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.toastEl);
  }

  toast(message) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(
      () => this.toastEl.classList.remove('is-visible'),
      1300
    );
  }

  // --- Per-frame sync ---------------------------------------------------

  update() {
    if (this.game.revision === this._lastRevision) return;
    this._lastRevision = this.game.revision;

    const { game, machine } = this;
    const mode = this.settings.get('game');

    if (mode === 'versus') {
      // The machine's drills mean nothing in a match; the bar carries the
      // room instead, which is the one thing you might need to read out loud.
      this.bar.querySelector('[data-bar-mode]').textContent = 'Versus';
      this.bar.querySelector('[data-bar-stats]').textContent = this._versus
        ? `room ${this._versus.code} · ${this._versus.role}`
        : 'no room';
      this.bar.querySelector('[data-toggle-label]').textContent = 'Pause';
      return;
    }

    if (mode === 'tournament') {
      const current = this._tournamentSnapshot?.matches?.find(
        (match) => match.id === this._tournamentSnapshot.currentMatchId
      );
      this.bar.querySelector('[data-bar-mode]').textContent = 'Tournament';
      this.bar.querySelector('[data-bar-stats]').textContent = current
        ? `${current.player1} ${current.score1} — ${current.score2} ${current.player2}`
        : 'opening bracket';
      this.bar.querySelector('[data-toggle-label]').textContent = 'Live';
      return;
    }

    this.bar.querySelector('[data-bar-mode]').textContent =
      mode === 'coach'
        ? `Coach · ${this.machine.coachName ?? ''}`.trim()
        : machine.mode.name;
    this.bar.querySelector('[data-bar-stats]').textContent = machine.isTargetMode
      ? `${game.targetsHit} targets · ${game.returns} on table`
      : `streak ${game.streak} · ${game.returns}/${game.hits + game.misses} on table`;
    this.bar.querySelector('[data-toggle-label]').textContent = machine.enabled
      ? 'Pause'
      : 'Arm';
  }
}
