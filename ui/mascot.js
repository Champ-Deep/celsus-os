// Celsus OS mascot. Original pixel characters drawn from matrices, no external assets, five species and eight looks.
// States: idle, blink, think, speak, ask, celebrate, sleep, error. Optional: drop a codex-pet style sheet you hold a
// licence for (8 columns x 9 rows, 192x208 frames) into ui/pets/ and describe it in ui/mascot.json to replace the drawing.
(function () {
  // Letters: o outline, b body, d dark accent, l light (belly, muzzle), w eye white, k pupil, y beak or nose, g accent, p cheek, z grey.
  // Every body is 18 wide x 20 tall. Rows 5 to 7, columns 5 to 7 and 12 to 14 are the eyes and get swapped per state.
  const SPECIES = {
    owl: [
      '..................',
      '.....oo....oo.....',
      '....obbo..obbo....',
      '...obbbbbbbbbbo...',
      '..obbbbbbbbbbbbo..',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbbbbbyybbbbbo.',
      '..obbbllllllllbbo.',
      '..obblllllllllbbo.',
      '..obbldlldlldlbbo.',
      '..obblllllllllbbo.',
      '..obbldlldlldlbbo.',
      '..obbblllllllbbbo.',
      '...obbbbbbbbbbbo..',
      '....obbbbbbbbbo...',
      '.....oyyo.oyyo....',
      '......oo...oo.....',
      '..................',
    ],
    cat: [
      '..................',
      '..oo..........oo..',
      '..obo........obo..',
      '..obbo......obbo..',
      '..obbbbbbbbbbbbo..',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbbbbbyybbbbbo.',
      '..obbbbblllllbbbo.',
      '...obbbbbbbbbbbo..',
      '....obbbbbbbbbo...',
      '...obbllllllllbo..',
      '...obbllllllllbo..',
      '...obbllllllllbo..',
      '...obbllllllllbdo.',
      '....obbbbbbbbbo.o.',
      '.....oyyo.oyyo....',
      '......oo...oo.....',
      '..................',
    ],
    fox: [
      '..................',
      '..oo..........oo..',
      '..oddo......oddo..',
      '..obddo....oddbo..',
      '..obbbbbbbbbbbbo..',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obblllbyybllbbo.',
      '..obbblllyyllbbbo.',
      '...obbbllllllbbo..',
      '....obbbbbbbbbo...',
      '...obbllllllllbo..',
      '..dobbllllllllbo..',
      '.ddobbbbbbbbbbbo..',
      '.dddobbbbbbbbbo...',
      '..dd.oyyo.oyyo....',
      '......oo...oo.....',
      '..................',
      '..................',
    ],
    bunny: [
      '.....oo....oo.....',
      '....oddo..oddo....',
      '....oddo..oddo....',
      '....oddo..oddo....',
      '...obbbbbbbbbbo...',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbbbbbyybbbbbo.',
      '..obbbbbbbbbbbbbo.',
      '...obbbbbbbbbbbo..',
      '....obbllllllbo...',
      '...obbllllllllbo..',
      '...obbllllllllbo..',
      '...obbllllllllbo..',
      '....obbbbbbbbbo...',
      '.....obbo.obbo....',
      '......oo...oo.....',
      '..................',
      '..................',
    ],
    robot: [
      '........oo........',
      '........og........',
      '.....oooooooo.....',
      '..oooobbbbbboooo..',
      '..obbbbbbbbbbbbo..',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbEEEbbbbEEEbo.',
      '..obbbbbbbbbbbbo..',
      '..obbzzzzzzzzzbo..',
      '..oooooooooooooo..',
      '....obbbbbbbbo....',
      '..oobbllllllbboo..',
      '..obbbllllllbbbo..',
      '..oobbllllllbboo..',
      '....obbbbbbbbo....',
      '.....oooo.oooo....',
      '.....ozzo.ozzo....',
      '......oo...oo.....',
      '..................',
    ],
  };
  const PALETTES = {
    owl:   { name: 'Library owl', species: 'owl',   o: '#2b2118', b: '#8a5a2b', d: '#6e4520', l: '#e8d5a8', w: '#ffffff', k: '#1d2227', y: '#e0a52a', g: '#d9a441', p: '#d98a8a', z: '#5c636b' },
    night: { name: 'Night owl',   species: 'owl',   o: '#141a22', b: '#3f5464', d: '#2f404d', l: '#c9d6df', w: '#ffffff', k: '#101418', y: '#5ec8b6', g: '#5ec8b6', p: '#a99af0', z: '#8a949c' },
    barn:  { name: 'Barn owl',    species: 'owl',   o: '#3a2a12', b: '#e8d5a8', d: '#cdb98a', l: '#fbf5e6', w: '#ffffff', k: '#2b2118', y: '#d9a441', g: '#a3731a', p: '#e0a1a1', z: '#8a7a60' },
    ember: { name: 'Ember owl',   species: 'owl',   o: '#2a1208', b: '#b8532a', d: '#96421f', l: '#f4c9a0', w: '#ffffff', k: '#1d1208', y: '#f2b134', g: '#f2b134', p: '#f08a8a', z: '#7a5a4a' },
    cat:   { name: 'Alley cat',   species: 'cat',   o: '#1c1a1f', b: '#4a4a55', d: '#33333c', l: '#d9d5cc', w: '#ffffff', k: '#1d2227', y: '#e39aa6', g: '#d9a441', p: '#e39aa6', z: '#8a949c' },
    ginger:{ name: 'Ginger cat',  species: 'cat',   o: '#3a2010', b: '#d9822b', d: '#b3661c', l: '#fbe9cf', w: '#ffffff', k: '#2b1a10', y: '#e0a1a1', g: '#d9a441', p: '#f0a0a0', z: '#8a7a60' },
    fox:   { name: 'Fox',         species: 'fox',   o: '#2a1208', b: '#d8692a', d: '#f4f0e6', l: '#fbf5e6', w: '#ffffff', k: '#1d1208', y: '#2b2118', g: '#d9a441', p: '#f08a8a', z: '#7a5a4a' },
    bunny: { name: 'Space bunny', species: 'bunny', o: '#1d2227', b: '#e9e5da', d: '#e39aa6', l: '#f7f4ee', w: '#ffffff', k: '#1d2227', y: '#e39aa6', g: '#5ec8b6', p: '#f0a0a0', z: '#8a949c' },
    robot: { name: 'Robot',       species: 'robot', o: '#141a22', b: '#6fa9ee', d: '#3e6ea8', l: '#c9d6df', w: '#dff3ff', k: '#1d2227', y: '#d9a441', g: '#d9a441', p: '#a99af0', z: '#2c3640' },
  };
  let VARIANT = 'owl';
  try { const v = localStorage.getItem('celsus.mascot'); if (v && PALETTES[JSON.parse(v)]) VARIANT = JSON.parse(v); } catch {}
  const PAL = () => PALETTES[VARIANT];
  const EYES = {
    open:   ['wwwwww', 'wkwwkw', 'wwwwww'],
    blink:  ['bbbbbb', 'oooooo', 'bbbbbb'],
    up:     ['wkwwkw', 'wwwwww', 'wwwwww'],
    side:   ['wwwwww', 'wwkwwk', 'wwwwww'],
    happy:  ['bbbbbb', 'koookk', 'obbbbo'],
    closed: ['bbbbbb', 'oooooo', 'bbbbbb'],
    wide:   ['wwwwww', 'wkkwkk', 'wwwwww'],
  };
  function frame(body, eyes, dy = 0, cheeks = false) {
    const rows = body.map(r => r.split(''));
    const e = EYES[eyes] || EYES.open;
    for (let i = 0; i < 3; i++) { const r = rows[5 + i]; for (let j = 0; j < 3; j++) { r[5 + j] = e[i][j]; r[12 + j] = e[i][3 + j]; } }
    if (cheeks) { rows[8][4] = 'p'; rows[8][13] = 'p'; }
    return { rows: rows.map(r => r.join('')), dy };
  }
  const ANIMS = {};
  function anim(species) {
    if (ANIMS[species]) return ANIMS[species];
    const B = SPECIES[species] || SPECIES.owl; const f = (e, dy, c) => frame(B, e, dy, c);
    return ANIMS[species] = {
      idle:      { fps: 2, frames: [f('open'), f('open'), f('open'), f('open', 1), f('open', 1), f('blink'), f('open')] },
      think:     { fps: 3, frames: [f('up'), f('up', 1), f('side'), f('side', 1), f('up')], extra: 'dots' },
      speak:     { fps: 4, frames: [f('open'), f('open', 1), f('wide'), f('open', 1)] },
      ask:       { fps: 2, frames: [f('wide'), f('wide', 1), f('open'), f('open', 1)], extra: 'card' },
      celebrate: { fps: 6, frames: [f('happy', 0, true), f('happy', -2, true), f('happy', -3, true), f('happy', -1, true)], extra: 'sparks' },
      sleep:     { fps: 1, frames: [f('closed', 1), f('closed', 2)], extra: 'zz' },
      error:     { fps: 3, frames: [f('side'), f('side', 1), f('wide')], extra: 'bang' },
    };
  }

  const instances = new Set();
  class Mascot {
    constructor(canvas, opts = {}) {
      this.cv = canvas; this.ctx = canvas.getContext('2d'); this.scale = opts.scale || 3; this.state = 'idle'; this.t = 0; this.fi = 0; this.idleSince = Date.now(); this.sheet = null;
      this.variant = opts.variant || null; // null follows the global choice
      canvas.width = 26 * this.scale; canvas.height = 24 * this.scale; canvas.style.imageRendering = 'pixelated';
      this.ctx.imageSmoothingEnabled = false;
      if (!opts.noSheet) fetch('/ui/mascot.json').then(r => r.ok ? r.json() : null).then(m => { if (m && m.spritesheet) this.loadSheet(m); }).catch(() => {});
      instances.add(this);
      this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
    }
    pal() { return PALETTES[this.variant] || PAL(); }
    loadSheet(m) { const img = new Image(); img.onload = () => { this.sheet = { img, m }; }; img.src = m.spritesheet; }
    set(state, opts = {}) { if (!anim(this.pal().species)[state]) state = 'idle'; if (this.state !== state) { this.state = state; this.fi = 0; this.t = 0; } if (state !== 'idle') this.idleSince = Date.now(); if (opts.for) { clearTimeout(this._rev); this._rev = setTimeout(() => this.set('idle'), opts.for); } }
    loop(ts) {
      if (!this.cv.isConnected && this._detached) return; if (!this.cv.isConnected) { this._detached = true; }
      const a = anim(this.pal().species)[this.state]; const dt = ts - (this.last || ts); this.last = ts; this.t += dt;
      if (this.t > 1000 / a.fps) { this.t = 0; this.fi = (this.fi + 1) % a.frames.length; }
      if (this.state === 'idle' && Date.now() - this.idleSince > 90000) this.set('sleep');
      this.draw(a, a.frames[this.fi]); requestAnimationFrame(this.loop);
    }
    draw(a, f) {
      const c = this.ctx, s = this.scale, P = this.pal(); c.clearRect(0, 0, this.cv.width, this.cv.height);
      if (this.sheet) { return this.drawSheet(); }
      const ox = 2, oy = 2 + (f.dy || 0);
      f.rows.forEach((row, y) => { for (let x = 0; x < row.length; x++) { const ch = row[x]; if (ch === '.') continue; c.fillStyle = P[ch] || P.o; c.fillRect((ox + x) * s, (oy + y) * s, s, s); } });
      const px = (x, y, col) => { c.fillStyle = col; c.fillRect(x * s, y * s, s, s); };
      if (a.extra === 'dots') { const n = this.fi % 4; for (let i = 0; i < n; i++) px(20 + i * 2, 3 - i, P.z); }
      if (a.extra === 'card') { for (let y = 8; y < 14; y++) for (let x = 19; x < 24; x++) px(x, y, y === 8 || y === 13 || x === 19 || x === 23 ? P.o : P.l); px(21, 10, P.g); px(21, 11, P.g); }
      if (a.extra === 'sparks') { const k = this.fi; [[1, 3], [23, 2], [3, 12], [24, 11]].forEach(([x, y], i) => { if ((i + k) % 2) px(x, y, P.g); }); }
      if (a.extra === 'zz') { const k = this.fi; px(20 + k, 4 - k, P.z); px(21 + k, 3 - k, P.z); px(22 + k, 2 - k, P.z); }
      if (a.extra === 'bang') { px(22, 2, P.p); px(22, 3, P.p); px(22, 4, P.p); px(22, 6, P.p); }
    }
    drawSheet() {
      // codex-pet layout: 8 columns x 9 rows. mascot.json maps a state to a row and frame count.
      const { img, m } = this.sheet; const fw = m.frameWidth || 192, fh = m.frameHeight || 208; const st = (m.states || {})[this.state] || (m.states || {}).idle || { row: 0, frames: 8 };
      const col = this.fi % (st.frames || 8); const c = this.ctx;
      c.drawImage(img, col * fw, (st.row || 0) * fh, fw, fh, 0, 0, this.cv.width, this.cv.height);
    }
  }
  Mascot.palettes = PALETTES;
  Mascot.species = Object.keys(SPECIES);
  Mascot.current = () => VARIANT;
  Mascot.setVariant = v => { if (PALETTES[v]) { VARIANT = v; try { localStorage.setItem('celsus.mascot', JSON.stringify(v)); } catch {} } };
  window.CelsusMascot = Mascot;
})();
