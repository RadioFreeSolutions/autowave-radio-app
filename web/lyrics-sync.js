/**
 * AutoWave Radio - live lyrics matching and sync engine.
 *
 * Radio has no timeline, so "synced" lyrics are only trustworthy when we know WHEN the song began.
 * This module makes that knowledge explicit and refuses to claim a sync it cannot back up.
 *
 * A lyric sync is reported as SYNCED only when ALL of these hold:
 *   1. the lyrics were matched to the live track with high confidence (artist AND title agree),
 *   2. we actually WITNESSED the song start (a title change while listening - not the title that was
 *      already playing when we tuned in),
 *   3. the lyrics carry a duration, and the song has not outlived it (otherwise the title is stale),
 *   4. the station's metadata timing has not been caught being unreliable.
 * Everything else is shown honestly: WAITING (auto-syncs at the next song), UNVERIFIED, LOST, PLAIN.
 * A line tapped by the listener is a human confirmation and becomes MANUAL.
 *
 * Time is measured on the MEDIA timeline (audio.currentTime), never wall-clock, so buffering stalls
 * and pauses cannot desynchronise the lyrics.
 *
 * Pure logic, no DOM: it is loaded by the web player and exercised by node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AutoWaveLyricsSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS = Object.freeze({
    NONE: 'none',
    LOADING: 'loading',
    PLAIN: 'plain',
    UNVERIFIED: 'unverified',
    WAITING: 'waiting',
    SYNCED: 'synced',
    MANUAL: 'manual',
    LOST: 'lost'
  });

  // Thresholds (documented so tests and the Kotlin port stay in agreement)
  const VERIFIED_COMBINED = 0.8;   // combined title/artist score needed to call a match "verified"
  const VERIFIED_TITLE = 0.78;     // title alone must be at least this close
  const VERIFIED_ARTIST = 0.6;     // artist alone must be at least this close
  const MIN_DURATION_SEC = 30;     // lyrics shorter than this have no usable duration window
  const OVERRUN_SEC = 4;           // how far past the lyric duration before we declare sync lost
  const EARLY_SEC = 3;             // how far before the anchor we tolerate (clock/jitter)
  const TIMING_TOLERANCE_SEC = 12; // |interval between titles - lyric duration| considered consistent
  const TIMING_BAD_SEC = 30;       // ...a next title this much EARLIER than the lyric duration is a timing failure

  // ---------------------------------------------------------------------------------------------
  // Text normalisation and similarity
  // ---------------------------------------------------------------------------------------------

  function normalizeText(s) {
    let t = String(s == null ? '' : s).toLowerCase();
    try { t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old engines */ }
    t = t.replace(/\(.*?\)|\[.*?\]/g, ' ');
    t = t.replace(/\s-\s(?:radio edit|single version|album version|remaster(?:ed)?(?:\s\d{4})?|\d{4}\s*remaster(?:ed)?|live|mono|stereo|remix|edit|extended(?:\smix)?|clean|explicit|version).*$/, ' ');
    t = t.replace(/\b(?:feat|ft|featuring)\b\.?.*$/, ' ');
    t = t.replace(/&/g, ' and ');
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^the\s+/, '');
    return t;
  }

  const STOP = new Set(['and', 'the', 'a', 'of']);

  function tokens(norm) {
    return norm.split(' ').filter(w => w && !STOP.has(w));
  }

  function levenshteinRatio(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) return 0;
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length);
  }

  /** Similarity in [0,1] between two display strings (titles or artist lists). */
  function similarity(a, b) {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = tokens(na);
    const tb = tokens(nb);
    // Compare with ALL letters kept (stop-words included): "M|A|R|R|S" must equal "Marrs"
    const compactA = na.replace(/\s/g, '');
    const compactB = nb.replace(/\s/g, '');
    if (compactA && compactA === compactB) return 1;

    const sa = new Set(ta);
    const sb = new Set(tb);
    let inter = 0;
    sa.forEach(w => { if (sb.has(w)) inter++; });
    const union = sa.size + sb.size - inter;
    const jaccard = union ? inter / union : 0;
    // Subset match (artist lists: "Shakira" vs "Shakira, Burna Boy") - never full credit
    const containment = Math.min(sa.size, sb.size) ? (inter / Math.min(sa.size, sb.size)) * 0.92 : 0;
    const edit = levenshteinRatio(compactA, compactB);
    return Math.max(jaccard, containment, edit);
  }

  /**
   * Strict "is this literally the same song re-announced?" test. Deliberately stricter than
   * similarity(): no subset credit, so "Dance" and "Dance Monkey" are different songs.
   */
  function sameSong(a, b) {
    const na = normalizeText(a).replace(/\s/g, '');
    const nb = normalizeText(b).replace(/\s/g, '');
    if (!na || !nb) return false;
    return na === nb || levenshteinRatio(na, nb) >= 0.93;
  }

  /** Radio convention is "Artist - Title". Returns {artist, title}; artist may be ''. */
  function parseTrack(raw) {
    const s = String(raw == null ? '' : raw).trim();
    const idx = s.indexOf(' - ');
    if (idx > 0) return { artist: s.slice(0, idx).trim(), title: s.slice(idx + 3).trim() };
    return { artist: '', title: s };
  }

  /**
   * Scores one lyrics candidate ({trackName, artistName}) against the live "Artist - Title".
   * Some stations send "Title - Artist", so the swapped reading is tried too.
   */
  function scoreCandidate(rawTrack, cand) {
    const q = parseTrack(rawTrack);
    const track = cand && cand.trackName || '';
    const artist = cand && cand.artistName || '';

    if (!q.artist) {
      const t = similarity(q.title, track);
      return { titleSim: t, artistSim: null, score: t * 0.85, swapped: false, hasArtist: false };
    }
    const direct = { t: similarity(q.title, track), a: similarity(q.artist, artist) };
    const swap = { t: similarity(q.artist, track), a: similarity(q.title, artist) };
    const combine = x => 0.6 * x.t + 0.4 * x.a;
    const useSwap = combine(swap) > combine(direct);
    const best = useSwap ? swap : direct;
    return { titleSim: best.t, artistSim: best.a, score: combine(best), swapped: useSwap, hasArtist: true };
  }

  function isVerified(sc) {
    return !!sc && sc.hasArtist && sc.score >= VERIFIED_COMBINED &&
      sc.titleSim >= VERIFIED_TITLE && sc.artistSim >= VERIFIED_ARTIST;
  }

  function hasSynced(c) {
    return !!(c && typeof c.syncedLyrics === 'string' && c.syncedLyrics.trim());
  }

  /**
   * Picks the best candidate. Prefers verified matches with synced lyrics, then verified plain,
   * then (unverified) best effort so the listener still gets something to read.
   * @returns {{cand, sc, verified, synced}|null}
   */
  function chooseBest(rawTrack, candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const scored = candidates
      .filter(c => c && (hasSynced(c) || (typeof c.plainLyrics === 'string' && c.plainLyrics.trim())))
      .map((c, i) => ({ cand: c, sc: scoreCandidate(rawTrack, c), synced: hasSynced(c), order: i }));
    if (!scored.length) return null;
    const rank = x => {
      const v = isVerified(x.sc);
      // verified+synced > verified+plain > unverified+synced > unverified+plain, then by score
      return (v ? 2 : 0) * 10 + (x.synced ? 1 : 0) * 5 + x.sc.score;
    };
    scored.sort((a, b) => {
      const d = rank(b) - rank(a);
      if (Math.abs(d) > 1e-9) return d;
      // tie: prefer a plausible full-length duration, then the API's own order
      const pa = durationOk(a.cand) ? 1 : 0, pb = durationOk(b.cand) ? 1 : 0;
      return (pb - pa) || (a.order - b.order);
    });
    const top = scored[0];
    return { cand: top.cand, sc: top.sc, verified: isVerified(top.sc), synced: top.synced };
  }

  function durationOk(c) {
    const d = Number(c && c.duration);
    return Number.isFinite(d) && d >= MIN_DURATION_SEC && d <= 1200;
  }

  // ---------------------------------------------------------------------------------------------
  // LRC parsing
  // ---------------------------------------------------------------------------------------------

  /**
   * Parses LRC text. Handles several timestamps per line, 1-3 digit fractions (".5", ".50", ".500"),
   * [mm:ss] without a fraction and blank lines (kept as an interlude marker so the highlight moves on).
   */
  function parseLrc(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(line => {
      const stamps = [];
      let rest = line.trim();
      let m;
      const re = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*/;
      while ((m = rest.match(re))) {
        const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0;
        stamps.push(parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac);
        rest = rest.slice(m[0].length);
      }
      if (!stamps.length) return;
      const textOut = rest.trim() || '♪';
      stamps.forEach(time => out.push({ time, text: textOut }));
    });
    // Collapse consecutive interlude markers
    const sorted = out.sort((a, b) => a.time - b.time);
    return sorted.filter((l, i) => !(l.text === '♪' && i > 0 && sorted[i - 1].text === '♪'));
  }

  // ---------------------------------------------------------------------------------------------
  // Sync engine
  // ---------------------------------------------------------------------------------------------

  class SyncEngine {
    constructor() {
      this.resetStream();
    }

    /** Called whenever the stream (re)connects: position continuity is gone, trust must be re-earned. */
    resetStream() {
      this.anchor = null;          // {startSec, fresh, title}
      this.prevAnchor = null;      // previous fresh anchor, for timing validation
      this.lyrics = null;          // {lines, durationSec, verified, plain, manualOnly}
      this.manualStart = null;     // media-time second at which the song is believed to have started
      this.nudgeSec = 0;
      this.seenTrackSinceConnect = false;
      this.timing = { trusted: false, strikes: 0 };
    }

    /**
     * A live title arrived.
     * @param {string} title
     * @param {number} mediaStartSec media-timeline second at which the song starts (or started)
     * @returns {{fresh:boolean}}
     */
    onTrack(title, mediaStartSec) {
      // Stations often re-send the same song with extra metadata ("Song" -> "Song (Album Version)").
      // That is NOT a new song: keep the existing anchor and lyrics instead of re-anchoring mid-song.
      if (this.anchor && sameSong(this.anchor.title, title)) {
        this.anchor.title = title;
        return { fresh: this.anchor.fresh, refinement: true };
      }
      const fresh = this.seenTrackSinceConnect;   // first title after connecting = mid-song
      // Timing validation: the gap between two witnessed song starts should match the lyric duration
      if (fresh && this.anchor && this.anchor.fresh && this.lyrics && this.lyrics.verified &&
          this.lyrics.durationSec >= MIN_DURATION_SEC && Number.isFinite(mediaStartSec)) {
        // delta > 0: ads/talk between songs (no title update) - says nothing about the title timing.
        // delta << 0: the next title came far earlier than this song can have ended, so the previous
        // title was probably announced LATE (or the song was cut): that is a timing failure.
        const delta = (mediaStartSec - this.anchor.startSec) - this.lyrics.durationSec;
        if (Math.abs(delta) <= TIMING_TOLERANCE_SEC) {
          this.timing.trusted = true;
          this.timing.strikes = 0;
        } else if (delta < -TIMING_BAD_SEC) {
          this.timing.strikes++;
          this.timing.trusted = false;
        }
      }
      this.seenTrackSinceConnect = true;
      this.prevAnchor = this.anchor;
      this.anchor = { startSec: mediaStartSec, fresh, title };
      this.lyrics = null;
      this.manualStart = null;
      this.nudgeSec = 0;
      return { fresh };
    }

    /**
     * The metadata connection was re-opened (e.g. after a pause). Its first title is timed against the
     * live edge, not against the audio we are hearing, so it must not be trusted as a witnessed start.
     */
    markNextTrackUncertain() {
      this.seenTrackSinceConnect = false;
    }

    /** @param {{lines:Array, durationSec:number, verified:boolean, plain:string[], manualOnly:boolean}|null} l */
    setLyrics(l) {
      this.lyrics = l;
      this.manualStart = null;
      this.nudgeSec = 0;
    }

    /** The listener tapped the line they are hearing right now. */
    manualSync(lineTimeSec, mediaNowSec) {
      this.manualStart = mediaNowSec - lineTimeSec;
      this.nudgeSec = 0;
    }

    nudge(deltaSec) { this.nudgeSec += deltaSec; }
    resetNudge() { this.nudgeSec = 0; }

    get timingDistrusted() { return this.timing.strikes >= 2; }

    /**
     * @param {number} mediaNowSec current media-timeline second
     * @returns {{status:string, elapsed:number|null, activeIndex:number, trusted:boolean, reason:string}}
     */
    evaluate(mediaNowSec) {
      const l = this.lyrics;
      const none = (status, reason) => ({ status, elapsed: null, activeIndex: -1, trusted: this.timing.trusted, reason });
      if (!l) return none(STATUS.NONE, 'no lyrics');
      if (!l.lines || !l.lines.length) return none(STATUS.PLAIN, 'plain lyrics only');

      const duration = l.durationSec;
      const hasDuration = Number.isFinite(duration) && duration >= MIN_DURATION_SEC;

      // Human-confirmed sync beats everything
      if (this.manualStart !== null) {
        const elapsed = mediaNowSec - this.manualStart + this.nudgeSec;
        if (hasDuration && elapsed > duration + OVERRUN_SEC + 6) return none(STATUS.LOST, 'song ended');
        return { status: STATUS.MANUAL, elapsed, activeIndex: indexAt(l.lines, elapsed), trusted: true, reason: 'tapped by listener' };
      }

      if (l.manualOnly) return none(STATUS.WAITING, 'tap the line you hear to sync');
      if (!l.verified) return none(STATUS.UNVERIFIED, 'lyrics may be a different song');
      if (!this.anchor || !this.anchor.fresh) return none(STATUS.WAITING, 'song start not witnessed');
      if (!hasDuration) return none(STATUS.WAITING, 'lyrics have no duration to validate against');
      if (this.timingDistrusted) return none(STATUS.WAITING, 'station metadata timing is unreliable');

      const elapsed = mediaNowSec - this.anchor.startSec + this.nudgeSec;
      if (elapsed < -EARLY_SEC) return none(STATUS.WAITING, 'song has not started yet');
      if (elapsed > duration + OVERRUN_SEC) return none(STATUS.LOST, 'song outlived its lyrics');
      return { status: STATUS.SYNCED, elapsed, activeIndex: indexAt(l.lines, elapsed), trusted: this.timing.trusted, reason: 'witnessed song start' };
    }
  }

  function indexAt(lines, elapsed) {
    // last line whose time <= elapsed (lines are sorted)
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= elapsed) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ---------------------------------------------------------------------------------------------
  // LRCLIB lookups (shared by the web player and the live tests)
  // ---------------------------------------------------------------------------------------------

  /**
   * Builds the ordered list of LRCLIB queries for a live title: exact artist+title first, then a
   * free-text query, then title only (candidates are re-ranked locally, so wide nets are safe).
   */
  function buildQueries(rawTrack) {
    const q = parseTrack(rawTrack);
    const base = 'https://lrclib.net/api/search';
    const enc = encodeURIComponent;
    const cleanTitle = normalizeText(q.title) || q.title;
    const urls = [];
    if (q.artist) {
      urls.push(`${base}?track_name=${enc(q.title)}&artist_name=${enc(q.artist)}`);
      urls.push(`${base}?q=${enc(q.artist + ' ' + q.title)}`);
      urls.push(`${base}?track_name=${enc(cleanTitle)}`);
    } else {
      urls.push(`${base}?q=${enc(q.title)}`);
    }
    return urls;
  }

  return {
    STATUS, VERIFIED_COMBINED, MIN_DURATION_SEC, OVERRUN_SEC, EARLY_SEC,
    normalizeText, similarity, parseTrack, scoreCandidate, isVerified, chooseBest, durationOk,
    parseLrc, SyncEngine, indexAt, buildQueries, sameSong
  };
});
