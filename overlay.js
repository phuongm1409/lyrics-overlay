'use strict';

const $ = id => document.getElementById(id);
let current = null;
let settings = {};
let lines = [];
let positionLocked = true;
let base = 0, at = 0, playing = false;
let activeIndex = -2, spans = [], noticeTimeout, rawStatus = 'Waiting for Spotify…';

function rgba(hex, opacity) {
  const color = parseInt(hex.slice(1), 16);
  return `rgba(${color >> 16 & 255},${color >> 8 & 255},${color & 255},${opacity})`;
}

function applySettings(value) {
  settings = value;
  const set = (key, val) => document.documentElement.style.setProperty(key, val);
  set('--accent', value.sweepColor);
  set('--ink', value.textColor);
  set('--size', value.fontSize + 'px');
  set('--weight', value.fontWeight);
  set('--font', "'" + value.fontFamily + "'");
  set('--font-style', value.fontStyle);
  set('--align', value.align);
  set('--dim', value.dimOpacity / 100);
  set('--radius', value.radius + 'px');
  set('--panel', rgba(value.bgColor, value.bgOpacity / 100));
  set('--outline', `rgba(183,160,232,${.36 * value.bgOpacity / 100})`);
  set('--shadow', value.shadowBlur && value.shadowOpacity
    ? `0 2px ${value.shadowBlur}px ${rgba(value.shadowColor, value.shadowOpacity / 100)}` : '0 0 transparent');
  refreshMeta();
  showMessage(rawStatus);
  activeIndex = -2;
}

function lockUI(locked) {
  const button = $('lock');
  positionLocked = locked;
  const label = locked ? 'Unlock position' : 'Lock position';
  button.querySelector('img').src = locked ? 'locked.svg' : 'unlocked.svg';
  button.title = locked ? label : 'Click to lock. Drag the header to move or an outer edge to resize.';
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(locked));
  document.body.classList.toggle('unlocked', !locked);
}

function notice(text) {
  clearTimeout(noticeTimeout);
  $('notice').textContent = text;
  $('notice').hidden = false;
  noticeTimeout = setTimeout(() => { $('notice').hidden = true; }, 4000);
}

function refreshMeta() {
  $('track-label').textContent = current && settings.showTrack ? `${current.artist} · ${current.title}` : '';
  $('source').textContent = current && settings.showSource ? current.source : '';
  $('source').hidden = !$('source').textContent;
  $('progress').hidden = !(current?.duration && settings.showProgress);
}

function showMessage(message) {
  rawStatus = message;
  $('message').textContent = message;
  $('message').hidden = settings.showStatus === false || !message;
}

function setTrack(track) {
  if (!current || track?.id !== current.id) {
    base = 0;
    at = performance.now();
    playing = false;
  }
  current = track;
  lines = track?.lines ?? [];
  activeIndex = -2;
  $('active').hidden = true;
  $('next').hidden = true;
  $('previous').hidden = true;
  $('plain').textContent = track?.plain ?? '';
  $('plain').hidden = !$('plain').textContent;
  refreshMeta();
  showMessage(track?.source === 'loading' ? 'Looking for lyrics…'
    : track && !lines.length && !track.plain ? 'No lyrics found. Use Upload to add a timed file.' : '');
}

function cueIndex(pos) {
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (lines[mid].t <= pos) low = mid + 1; else high = mid;
  }
  return low - 1;
}

function updateLine(index, shown) {
  activeIndex = index;
  const el = $('active');
  el.replaceChildren();
  el.hidden = !shown;
  spans = [];
  if (shown) {
    for (const part of lines[index].text.split('\n')) {
      const outer = document.createElement('div');
      const inner = document.createElement('span');
      const text = document.createElement('span');
      inner.className = 'sweep-line';
      text.className = 'sweep-text';
      text.textContent = part;
      inner.append(text);
      outer.append(inner);
      el.append(outer);
      spans.push({ node: text, length: part.length });
    }
  }
  for (const [id, enabled, cue] of [
    ['previous', settings.showPrevious, lines[index - 1]],
    ['next', settings.showNext, lines[index + 1]]
  ]) {
    $(id).textContent = cue?.text ?? '';
    $(id).hidden = !enabled || !cue?.text;
  }
}

function fillPosition(cue, end, pos) {
  const stops = [{ t: cue.t, at: 0 }, ...cue.marks, { t: end, at: cue.text.length }]
    .sort((a, b) => a.t - b.t);
  let index = 0;
  while (index + 1 < stops.length && pos >= stops[index + 1].t) index++;
  const left = stops[index], right = stops[index + 1];
  return right ? left.at + (right.at - left.at) * Math.max(0, (pos - left.t) / (right.t - left.t)) : left.at;
}

function frame(now) {
  const elapsed = base + (playing ? now - at : 0);
  const pos = elapsed + (settings.syncOffset ?? 0);
  if (current?.duration && settings.showProgress) {
    $('progress').firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, elapsed / current.duration))})`;
  }
  if (lines.length) {
    const index = cueIndex(pos), cue = lines[index];
    const shown = Boolean(cue?.text && (cue.end == null || pos < cue.end));
    if (index !== activeIndex || $('active').hidden === shown) updateLine(index, shown);
    if (shown) {
      const end = cue.end ?? lines[index + 1]?.t ?? (current.duration > cue.t ? current.duration : cue.t + 3000);
      let lit = fillPosition(cue, end, pos);
      for (const { node, length } of spans) {
        const fill = length ? Math.min(100, Math.max(0, 100 * lit / length)) : 0;
        node.style.setProperty('--fill', fill.toFixed(2) + '%');
        lit -= length + 1;
      }
    }
  }
  requestAnimationFrame(frame);
}

const buttons = ['lock', 'upload', 'menu', 'close'].map($);
const lockButton = $('lock');
const surface = $('surface');
const grips = [...$('resize-grips').children];
let dragHeight = 0;
let gesture = null;
let suppressLockClick = false;

function reportHitAreas() {
  dragHeight = $('shell').offsetTop + document.querySelector('.top').offsetHeight;
  surface.style.setProperty('--drag-height', dragHeight + 'px');
  const rect = element => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom };
  };
  const edges = grips.map(grip => ({ ...rect(grip), edge: grip.dataset.edge }));
  void api.invoke('overlay:hit-areas', { rects: buttons.map(rect), dragHeight, edges });
}
new ResizeObserver(reportHitAreas).observe(document.documentElement);
surface.addEventListener('transitionend', reportHitAreas);

document.addEventListener('pointerdown', event => {
  suppressLockClick = false;
  if (positionLocked || gesture || event.button !== 0 || !event.isPrimary) return;
  const control = event.target.closest('button');
  const grip = event.target.closest('[data-edge]');
  if (!grip && (event.clientY >= dragHeight || (control && control !== lockButton))) return;

  const capture = control || grip || surface;
  capture.setPointerCapture(event.pointerId);
  gesture = { id: event.pointerId, atLock: control === lockButton };
  surface.style.transformOrigin = event.clientX + 'px ' + event.clientY + 'px';
  void api.invoke('overlay:drag-start', {
    x: event.clientX, y: event.clientY, edge: grip?.dataset.edge ?? (control === lockButton && event.shiftKey ? 'se' : null)
  });
});

function finishDrag(event) {
  if (gesture?.id !== event.pointerId) return;
  const { atLock } = gesture;
  gesture = null;
  const released = event.type === 'pointerup';
  if (atLock && released) suppressLockClick = true;
  void api.invoke('overlay:drag-end', !released).then(moved => {
    if (atLock && released && !moved) return api.invoke('overlay:lock');
  });
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  document.addEventListener(event, finishDrag);
}
api.on('dragging', dragging => document.body.classList.toggle('dragging', dragging));

for (const button of buttons) {
  button.addEventListener('click', event => {
    if (button === lockButton && suppressLockClick && event.detail > 0) {
      suppressLockClick = false;
      return;
    }
    void api.invoke('overlay:' + button.id).catch(() => notice('This action could not be completed.'));
  });
}
api.invoke('settings:get').then(applySettings);
api.on('settings', applySettings);
api.on('locked', lockUI);
api.on('track', setTrack);
api.on('notice', notice);
api.on('status', message => { setTrack(null); showMessage(message); });
api.on('progress', progress => {
  base = progress.ms;
  at = performance.now();
  playing = progress.playing;
});
requestAnimationFrame(frame);
