'use strict';

function time(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
  const stamp = String(value ?? '').trim().replace(',', '.');
  const parts = stamp.split(':');
  if (parts.length > 3 || !parts.every(part => /^\d+(?:\.\d+)?$/.test(part))) return null;
  return Math.round(parts.reduce((sum, part) => sum * 60 + Number(part), 0) * 1000);
}

function decodeFile(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const evenLength = bytes.length - (bytes.length % 2);
    return Buffer.from(bytes.subarray(2, evenLength)).swap16().toString('utf16le');
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

const clock = '\\d+(?::\\d{1,2}){1,2}(?:[.,]\\d+)?';
const lrcStamp = new RegExp('\\[(' + clock + ')\\]', 'g');
const inlineStamp = new RegExp('<(' + clock + ')>', 'g');
const range = new RegExp('^\\s*(' + clock + ')\\s*(?:-->|,|\\s+-\\s+)\\s*(' + clock + ')(?=\\s|$)(.*)$');
const single = new RegExp('^\\s*(?:\\[(' + clock + ')\\]\\s*|(' + clock + ')(?:\\s*[-–|]\\s*|\\s+|$))(.*)$');

function entities(value) {
  const basic = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/ig, (match, name) => {
    if (name[0] !== '#') return basic[name.toLowerCase()] ?? match;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function clean(value) {
  return entities(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
}

function lyricText(value) {
  const marks = [];
  const text = clean(value.replace(inlineStamp, (_, token, position) => {
    const prefix = value.slice(0, position);
    const length = clean(prefix).length;
    marks.push({ at: length + Number(/\s$/.test(prefix) && length > 0), t: time(token) });
    return '';
  }));
  return { text, marks };
}

function parse(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const lines = [];
  function add(t, end, value) {
    if (t === null || !Number.isFinite(t)) return;
    const entry = lyricText(String(value ?? ''));
    lines.push({ t, end: end > t ? end : null, ...entry });
  }

  // Common JSON transcripts, including YouTube JSON3.
  if (/^[\[{]/.test(raw)) {
    try {
      const data = JSON.parse(raw);
      const entries = Array.isArray(data) ? data : data.events ?? data.segments ?? data.cues ?? data.lines ?? [];
      for (const entry of entries) {
        if (entry.tStartMs != null && Array.isArray(entry.segs)) {
          const start = Number(entry.tStartMs);
          const line = entry.segs.map(seg => {
            const stamp = start + Number(seg.tOffsetMs ?? 0);
            return (seg.tOffsetMs == null || !Number.isFinite(stamp) ? '' : '<' + Math.floor(stamp / 60000)
              + ':' + ((stamp % 60000) / 1000).toFixed(3) + '>') + (seg.utf8 ?? '');
          }).join('');
          if (line.trim()) add(start, start + Number(entry.dDurationMs), line);
        } else {
          const start = entry.startMs != null || entry.t != null ? Number(entry.startMs ?? entry.t) : time(entry.start ?? entry.begin);
          const end = entry.endMs != null ? Number(entry.endMs) : time(entry.end);
          if (entry.text != null) add(start, end, entry.text);
        }
      }
    } catch {}
  }

  if (!lines.length) {
    // TTML / DFXP / YouTube timedtext.
    const xmlTime = value => {
      if (value == null) return null;
      const units = /^([\d.]+)(ms|s|m|h)$/.exec(value);
      if (units) return Number(units[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[units[2]];
      return time(value);
    };
    for (const [, , attrs, value] of raw.matchAll(/<(?:[\w-]+:)?(p|text)\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?\1>/gi)) {
      const attr = name => new RegExp('(?:^|\\s)' + name + '\\s*=\\s*["\']([^"\']+)["\']', 'i').exec(attrs)?.[1];
      const start = xmlTime(attr('begin') ?? attr('start')) ?? (attr('t') == null ? null : Number(attr('t')));
      if (start == null) continue;
      const duration = xmlTime(attr('dur')) ?? (attr('d') == null ? null : Number(attr('d')));
      add(start, xmlTime(attr('end')) ?? (duration == null ? null : start + duration), value);
    }
  }

  const rows = raw.split('\n');
  if (!lines.length) {
    // ASS / SSA explicitly declare their dialogue field order.
    let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    for (const row of rows) {
      if (/^Format:/i.test(row)) {
        const format = row.slice(7).toLowerCase().split(',').map(field => field.trim());
        if (format.includes('start') && format.includes('end') && format.at(-1) === 'text') fields = format;
      }
      if (!/^Dialogue:/i.test(row)) continue;
      const parts = row.slice(9).trimStart().split(',');
      add(time(parts[fields.indexOf('start')]), time(parts[fields.indexOf('end')]),
        parts.slice(fields.indexOf('text')).join(',').replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
    }
  }

  if (!lines.length) {
    // SRT, WebVTT, SBV, and TXT files with start/end ranges.
    for (let i = 0; i < rows.length; i++) {
      const match = range.exec(rows[i]);
      if (!match) continue;
      const body = [];
      const inline = match[3].trim();
      if (inline && !/^(?:align|line|position|size|vertical|region):/.test(inline)) body.push(inline);
      while (i + 1 < rows.length && rows[i + 1].trim() && !range.test(rows[i + 1])) {
        if (/^\d+$/.test(rows[i + 1].trim()) && range.test(rows[i + 2] ?? '')) break;
        body.push(rows[++i]);
      }
      add(time(match[1]), time(match[2]), body.join('\n'));
    }
  }

  if (!lines.length) {
    // LRC (multiple line stamps, enhanced word stamps, and global offset) and simple timestamped TXT.
    const shift = Number(/^\s*\[offset:\s*([+-]?\d+)\]/im.exec(raw)?.[1] ?? 0);
    for (const row of rows) {
      const start = single.exec(row);
      if (!start) continue;
      if (!start[1]) {
        if (/[:.,]/.test(start[2]) || /^\s*\d+\s*[-–|]/.test(row)) add(time(start[2]), null, start[3]);
        continue;
      }
      const prefix = new RegExp('^(?:\\[' + clock + '\\])+').exec(row.trimStart())?.[0] ?? '';
      if (!prefix) continue;
      const stamps = [...prefix.matchAll(lrcStamp)].map(stamp => time(stamp[1]));
      for (const stamp of stamps) {
        add(Math.max(0, stamp - shift), null, row.trimStart().slice(prefix.length));
        lines.at(-1).marks.forEach(mark => { mark.t = Math.max(0, mark.t + stamp - stamps[0] - shift); });
      }
    }
  }

  // SAMI uses a new sync block to end the previous caption.
  if (!lines.length) for (const [, start, value] of raw.matchAll(/<sync\s+start\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|<\/body>|$)/gi)) {
    add(Number(start), null, value);
  }

  lines.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const cue of lines) {
    const last = merged.at(-1);
    if (!last || last.t !== cue.t) { merged.push(cue); continue; }
    if (cue.text && last.text !== cue.text) {
      const offset = last.text ? last.text.length + 1 : 0;
      last.text = [last.text, cue.text].filter(Boolean).join('\n');
      last.marks.push(...cue.marks.map(mark => ({ ...mark, at: mark.at + offset })));
    }
    last.end = Math.max(last.end ?? 0, cue.end ?? 0) || null;
  }
  return merged.length ? { lines: merged, plain: '' } : { lines: [], plain: raw };
}

module.exports = { parse, decodeFile };
