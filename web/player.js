/**
 * AutoWave Radio Web Player
 * High-performance, zero-dependency streaming radio engine with HLS fallback,
 * MediaSession steering-wheel integration, and driving mode.
 */

(function () {
  'use strict';

  // Safe storage: private mode, blocked cookies or a full quota must never break playback.
  // This shadows the global on purpose so every existing call below is protected.
  const localStorage = {
    getItem(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    setItem(key, val) { try { window.localStorage.setItem(key, val); } catch (e) {} },
    removeItem(key) { try { window.localStorage.removeItem(key); } catch (e) {} }
  };

  // Streams that are plain http:// only and have no working https endpoint (verified Nov 2026).
  // Browsers block/upgrade http audio on this https page, so they can never play on the web.
  // They remain in the shared catalog for the Android app, which allows cleartext traffic.
  // (Dead streams are not listed here: they are blacklisted from the catalog itself, see BLACKLIST.md.)
  const WEB_UNPLAYABLE = new Set([
    '942218e4-32f2-4131-8a73-e3432a8cf4d0', '7f7e3c30-08f0-4f52-a0a0-653d5a184800', '9606ceae-0601-11e8-ae97-52543be04c81',
    '1a8ae079-d15a-4309-9df0-55590df8e3c2', '2982e72e-6e80-4fe3-b119-0f44d8f1f789', 'a51b79dd-68e6-44ce-8ebe-2fb5d909c318',
    '963f9bfc-0601-11e8-ae97-52543be04c81', '72e3e855-4a87-43f5-a431-5b5aba8ee5da',
    '6749ce2d-15b6-47f1-a6ec-bcd32b49ffd1', '1d110b47-b10e-4839-af42-dea9a83bcbd6', '89199933-8a91-4afb-879f-0c4cd72c769e',
    '22256540-0fc5-4dc2-a3ed-de8085377ef7', '824b1a6a-660f-4902-8a01-fe54aa27e24f', '074d4810-cd95-4bd4-bec4-8d54fb1cd692'
  ]);

  // State
  const stations = (window.AUTOWAVE_STATIONS || []).filter(s => !WEB_UNPLAYABLE.has(s.id));
  let filteredStations = [...stations];
  let currentStation = null;
  let currentIndex = -1;
  let isPlaying = false;
  let isBuffering = false;
  let currentMood = 'ALL';
  let searchQuery = '';
  let hlsInstance = null;
  let retryCount = 0;
  let consecutiveAutoSkips = 0;
  const MAX_AUTO_SKIPS = 3;

  // Shuffle & History state (Default: ON, saved across sessions)
  const LS_SHUFFLE = 'autowave_radio_shuffle';
  let isShuffle = true;
  try {
    const savedShuffle = localStorage.getItem(LS_SHUFFLE);
    if (savedShuffle !== null) {
      isShuffle = (savedShuffle === 'true');
    }
  } catch (e) {
    isShuffle = true;
  }
  let shuffleDeck = [];
  let playbackHistory = [];
  const MAX_HISTORY = 50;
  let lastNavTimestamp = 0;
  const NAV_DEBOUNCE_MS = 500;

  // LocalStorage keys
  const LS_FAVS = 'autowave_radio_favorites';
  const LS_VOLUME = 'autowave_radio_volume';
  const LS_LAST_STATION = 'autowave_radio_last_station';
  const LS_BLOCKED = 'autowave_radio_blocked';

  // Load favorites (with seamless fallback/migration from legacy keys)
  let favorites = new Set();
  try {
    const rawFavs = localStorage.getItem(LS_FAVS) || localStorage.getItem('drivewave_web_favorites') || '[]';
    const savedFavs = JSON.parse(rawFavs);
    favorites = new Set(savedFavs);
  } catch (e) {
    favorites = new Set();
  }

  // Load blocked stations (with seamless fallback/migration from legacy keys)
  let blockedStations = new Set();
  try {
    const rawBlocked = localStorage.getItem(LS_BLOCKED) || localStorage.getItem('drivewave_web_blocked') || '[]';
    blockedStations = new Set(JSON.parse(rawBlocked));
  } catch (e) {
    blockedStations = new Set();
  }

  // Audio element
  const audio = new Audio();
  audio.preload = 'auto';
  (function initVolume() {
    const raw = parseFloat(localStorage.getItem(LS_VOLUME) || localStorage.getItem('drivewave_web_volume') || '0.85');
    audio.volume = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.85;
  })();

  // Reconnect / pause bookkeeping
  const LIVE_RESUME_STALE_MS = 15000; // a paused live stream older than this is reloaded instead of resumed
  let pausedAt = 0;
  let lastStartAt = 0;
  let retryTimer = null;
  let streamOffline = false;
  let currentStreamUrl = '';

  // 10-Minute Idle Battery Saver Watchdog
  let idleShutdownTimer = null;
  const IDLE_SHUTDOWN_TIMEOUT_MS = 600000; // 10 minutes

  function startIdleShutdownWatchdog() {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = setTimeout(() => {
      if (!isPlaying) {
        if (hlsInstance) {
          try {
            hlsInstance.destroy();
          } catch (e) {}
          hlsInstance = null;
        }
        stopIcyMetadataReader();
        try {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        } catch (e) {}
        console.log('AutoWave Web: 10-minute battery saver auto-shutdown complete.');
      }
    }, IDLE_SHUTDOWN_TIMEOUT_MS);
  }

  function cancelIdleShutdownWatchdog() {
    if (idleShutdownTimer) {
      clearTimeout(idleShutdownTimer);
      idleShutdownTimer = null;
    }
  }


  // DOM Elements
  const stationsGrid = document.getElementById('stations-grid');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const shelfTitle = document.getElementById('shelf-title');
  const shelfSubtitle = document.getElementById('shelf-subtitle');
  const btnUnblockAll = document.getElementById('btn-unblock-all');
  const navItems = document.querySelectorAll('.nav-item');

  // Player DOM Elements
  const playerArt = document.getElementById('player-art');
  const playerTrack = document.getElementById('player-track');
  const playerStation = document.getElementById('player-station');
  const shuffleBtn = document.getElementById('btn-shuffle');
  const playPauseBtn = document.getElementById('btn-play-pause');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const prevBtn = document.getElementById('btn-prev');
  const nextBtn = document.getElementById('btn-next');
  const equalizer = document.getElementById('equalizer');
  const volumeSlider = document.getElementById('volume-slider');
  const favPlayerBtn = document.getElementById('btn-player-fav');

  // Driving Mode Elements
  const drivingModeOverlay = document.getElementById('driving-mode-overlay');
  const btnDrivingMode = document.getElementById('btn-driving-mode');
  const btnExitDm = document.getElementById('btn-exit-dm');
  const dmArtwork = document.getElementById('dm-artwork');
  const dmTrackTitle = document.getElementById('dm-track-title');
  const dmStationName = document.getElementById('dm-station-name');
  const dmShuffleBtn = document.getElementById('dm-btn-shuffle');
  const dmPlayPauseBtn = document.getElementById('dm-btn-play');
  const dmPlayIcon = document.getElementById('dm-play-icon');
  const dmPauseIcon = document.getElementById('dm-pause-icon');
  const dmPrevBtn = document.getElementById('dm-btn-prev');
  const dmNextBtn = document.getElementById('dm-btn-next');

  // Floating Corner Mini Widget Elements
  const cornerMiniWidget = document.getElementById('corner-mini-widget');
  const btnMiniClose = document.getElementById('btn-mini-close');
  const miniArt = document.getElementById('mini-art');
  const miniTitle = document.getElementById('mini-title');
  const miniSub = document.getElementById('mini-sub');
  const miniShuffleBtn = document.getElementById('btn-mini-shuffle');
  const btnMiniPrev = document.getElementById('btn-mini-prev');
  const btnMiniPlay = document.getElementById('btn-mini-play');
  const miniPlayIcon = document.getElementById('mini-play-icon');
  const miniPauseIcon = document.getElementById('mini-pause-icon');
  const btnMiniNext = document.getElementById('btn-mini-next');
  const btnMiniPip = document.getElementById('btn-mini-pip');
  const btnToggleMini = document.getElementById('btn-toggle-mini');

  // Information & Legal Modal Elements
  const infoModal = document.getElementById('info-modal');
  const navInfoBtn = document.getElementById('nav-info-btn');
  const btnInfoClose = document.getElementById('btn-info-close');

  const volumePercent = document.getElementById('volume-percent');
  const btnMute = document.getElementById('btn-mute');

  // Hero ("Now Playing") elements
  const heroEl = document.getElementById('now-hero');
  const heroArt = document.getElementById('hero-art');
  const heroKicker = document.getElementById('hero-kicker');
  const heroTitle = document.getElementById('hero-title');
  const heroSub = document.getElementById('hero-sub');
  const heroPlayBtn = document.getElementById('hero-play');
  const heroPlayLabel = document.getElementById('hero-play-label');
  const heroLyricsBtn = document.getElementById('hero-lyrics');
  const heroFavBtn = document.getElementById('hero-fav');

  /** Small helpers */
  function iconSvg(id) {
    return '<svg class="i"><use href="#' + id + '"/></svg>';
  }
  function heartSvg(on) {
    return iconSvg(on ? 'i-heart-fill' : 'i-heart');
  }
  function shortCountry(c) {
    if (!c) return 'Live';
    if (/united kingdom/i.test(c)) return 'UK';
    if (/united states/i.test(c)) return 'USA';
    return c;
  }
  function showToast(msg, kind) {
    const region = document.getElementById('toast-region');
    if (!region) return;
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
    el.textContent = msg;
    region.appendChild(el);
    while (region.children.length > 3) region.removeChild(region.firstChild);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 3200);
  }
  window.AutoWaveToast = showToast;

  function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  function setBuffering(on) {
    isBuffering = on;
    [playPauseBtn, dmPlayPauseBtn, btnMiniPlay, heroPlayBtn].forEach(b => { if (b) b.classList.toggle('is-buffering', on); });
    updateHero();
  }

  function updateVolumeTrack(val) {
    const pct = Math.round(val * 100);
    if (volumeSlider) {
      volumeSlider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, rgba(255, 255, 255, 0.2) ${pct}%, rgba(255, 255, 255, 0.2) 100%)`;
    }
    if (volumePercent) {
      volumePercent.textContent = `${pct}%`;
    }
  }

  // Set initial volume slider
  if (volumeSlider) {
    volumeSlider.value = audio.volume;
    updateVolumeTrack(audio.volume);
  }

  // Mood Descriptions
  const MOOD_META = {
    ALL: { title: '🔥 All Stations', subtitle: 'Curated live radio broadcasts from the UK and US.' },
    POP_HITS: { title: '⭐ Top Rated', subtitle: 'World-famous pop hit music stations and chart-toppers.' },
    LONG_DRIVE: { title: '🛣️ Long Drive', subtitle: 'Highway cruising rhythms, road trip classics, and steady tempo hits.' },
    FUN_ENERGY: { title: '⚡ Fun & Energy', subtitle: 'Dance hits, electronic energy, and party anthems to keep your drive energized.' },
    CALM_CHILL: { title: '☕ Calm & Chill', subtitle: 'Relaxed acoustics, soft vocals, and ambient companions for night cruising.' },
    ROCK: { title: '🎸 Rock Anthems', subtitle: 'Classic guitar riffs, 90s alt-rock anthems, and stadium rock.' },
    NEWS_COMMUTE: { title: '📰 News & Commute', subtitle: '24/7 world journalism, traffic, and talk in crystal-clear broadcasts.' },
    FAVORITES: { title: '❤️ Favorites', subtitle: 'Your saved road-trip radio stations.' },
    BLOCKED: { title: '🚫 Blocked Stations', subtitle: 'Stations you have blocked. They will not play in shuffle or appear in categories.' }
  };

  /** Initialize App */
  function init() {
    startIdleShutdownWatchdog();
    updateBadges();
    updateShuffleUI();
    applyFilter();
    setupEventListeners();
    setupMediaSession();

    if (searchInput) {
      searchInput.placeholder = 'Search curated stations, genres, or artists...';
    }
    updateHero();

    // Restore last station if saved (never restore a blocked station)
    const lastId = localStorage.getItem(LS_LAST_STATION) || localStorage.getItem('drivewave_web_last_station');
    if (lastId && !blockedStations.has(lastId)) {
      const found = stations.find(s => s.id === lastId);
      if (found) {
        setStationUI(found, false);
      }
    } else if (filteredStations.length > 0) {
      setStationUI(filteredStations[0], false);
    } else if (stations.length > 0) {
      const firstValid = stations.find(s => !blockedStations.has(s.id));
      if (firstValid) setStationUI(firstValid, false);
    }
  }

  function refillShuffleDeck() {
    if (filteredStations.length === 0) {
      shuffleDeck = [];
      return;
    }
    const indices = [];
    for (let i = 0; i < filteredStations.length; i++) {
      if (currentIndex === -1 || i !== currentIndex) {
        indices.push(i);
      }
    }
    // Fisher-Yates shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = indices[i];
      indices[i] = indices[j];
      indices[j] = temp;
    }
    shuffleDeck = indices;
  }

  function toggleShuffle() {
    isShuffle = !isShuffle;
    localStorage.setItem(LS_SHUFFLE, isShuffle ? 'true' : 'false');
    updateShuffleUI();
    if (isShuffle) {
      refillShuffleDeck();
    }
  }

  function updateShuffleUI() {
    const btns = [shuffleBtn, dmShuffleBtn, miniShuffleBtn];
    btns.forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('active', isShuffle);
      btn.setAttribute('aria-pressed', isShuffle ? 'true' : 'false');
      btn.title = isShuffle ? 'Shuffle is ON (Click to turn OFF)' : 'Shuffle is OFF (Click to turn ON)';
    });
  }

  /** Update sidebar counts */
  function updateBadges() {
    document.querySelectorAll('[data-mood]').forEach(el => {
      const mood = el.getAttribute('data-mood');
      const badge = el.querySelector('.nav-badge');
      if (!badge) return;
      if (mood === 'FAVORITES') {
        badge.textContent = favorites.size;
        badge.style.display = favorites.size > 0 ? '' : 'none';
      } else if (mood === 'BLOCKED') {
        badge.textContent = blockedStations.size;
        badge.style.display = blockedStations.size > 0 ? '' : 'none';
      } else {
        badge.style.display = 'none';
      }
    });

    const mobileFavBadge = document.getElementById('mobile-fav-badge');
    if (mobileFavBadge) {
      mobileFavBadge.textContent = favorites.size;
    }
    const mobileBlockedBadge = document.getElementById('mobile-blocked-badge');
    if (mobileBlockedBadge) {
      mobileBlockedBadge.textContent = blockedStations.size;
    }
  }

  /** Filter stations based on mood and search query */
  function applyFilter() {
    filteredStations = stations.filter(s => {
      if (currentMood === 'BLOCKED') {
        if (!blockedStations.has(s.id)) return false;
      } else {
        // Exclude blocked stations from normal browsing
        if (blockedStations.has(s.id)) return false;

        // Mood match
        if (currentMood === 'FAVORITES') {
          if (!favorites.has(s.id)) return false;
        } else if (currentMood !== 'ALL') {
          if (!s.moods || !s.moods.includes(currentMood)) return false;
        }
      }

      // Search match
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const combined = `${s.name} ${s.country} ${(s.tags || []).join(' ')}`.toLowerCase();
        if (!combined.includes(q)) return false;
      }

      return true;
    });

    refillShuffleDeck();

    // Update shelf title and subtitle dynamically
    const meta = MOOD_META[currentMood] || MOOD_META.ALL;
    if (shelfTitle) shelfTitle.innerHTML = meta.title;
    if (shelfSubtitle) {
      if (currentMood === 'ALL' && !searchQuery) {
        shelfSubtitle.textContent = 'Hand-picked, verified live radio broadcasts.';
      } else {
        shelfSubtitle.textContent = meta.subtitle;
      }
    }

    if (btnUnblockAll) {
      btnUnblockAll.style.display = (currentMood === 'BLOCKED' && blockedStations.size > 0) ? 'inline-flex' : 'none';
    }

    renderStations();
  }

  /** Generate a short, clean monogram from a station name */
  function getStationMonogram(name) {
    if (!name) return 'AW';
    const clean = name.replace(/[\(\[\{].*?[\)\]\}]/g, '').trim();

    // Hebrew stations
    if (clean.includes('גלגלצ')) return 'גלגלצ';
    if (clean.includes('גלצ')) return 'גלצ';
    if (clean.includes('כאן')) {
      const part = clean.split('כאן')[1].trim();
      if (part.includes('גימל') || part.includes('ג')) return 'כאן ג';
      if (part.includes('ב') || part.includes('בת')) return 'כאן ב';
      if (part.includes('תרבות')) return 'תרבות';
      if (part.includes('88')) return 'כאן 88';
      if (part.includes('מורשת')) return 'מורשת';
      if (part.includes('קול המוסיקה')) return 'מוסיקה';
      return 'כאן ' + (part.length > 0 ? part[0] : 'ת');
    }
    if (clean.includes('אקו 99') || clean.includes('eco99') || clean.includes('Eco 99')) return 'eco99';
    if (clean.includes('100FM') || clean.includes('100 FM') || clean.includes('רדיוס')) return '100FM';
    if (clean.includes('103FM') || clean.includes('103 FM')) return '103FM';
    if (clean.includes('102FM') || clean.includes('102 FM') || clean.includes('תל אביב')) return '102FM';
    if (clean.includes('לב המדינה') || clean.includes('91FM')) return '91FM';
    if (clean.includes('צפון ללא הפסקה') || clean.includes('104.5')) return '104.5';
    if (clean.includes('קול ברמה')) return 'ברמה';
    if (clean.includes('קול חי')) return 'קול חי';
    if (clean.includes('רדיו חיפה')) return 'חיפה';
    if (clean.includes('רדיו ירושלים')) return 'י-ם';
    if (clean.includes('רדיו דרום')) return 'דרום';

    // Radio Paradise
    if (clean.toLowerCase().includes('radio paradise')) {
      if (/rock/i.test(clean)) return 'RP RCK';
      if (/mellow/i.test(clean)) return 'RP MLW';
      if (/world/i.test(clean)) return 'RP WLD';
      return 'RP MAIN';
    }

    // 181.FM
    if (/181\.fm/i.test(clean)) {
      const after = clean.replace(/181\.fm\s*[-–:]?\s*/i, '').trim();
      if (/80/i.test(after)) return '80s';
      if (/90/i.test(after)) return '90s';
      if (/the\s*mix/i.test(after)) return 'MIX';
      if (/the\s*office/i.test(after)) return 'OFFICE';
      if (/uk\s*top/i.test(after)) return 'UK TOP';
      if (/eagle/i.test(after)) return 'EAGLE';
      if (/beatles/i.test(after)) return 'BEAT';
      if (/beat/i.test(after)) return 'BEAT';
      if (/gold/i.test(after)) return 'GOLD';
      if (/highway|hwy/i.test(after)) return 'HWY 181';
      if (/kickin/i.test(after)) return 'KICKIN';
      if (/vibe/i.test(after)) return 'VIBE';
      if (/power\s*explicit/i.test(after)) return 'PWR EXP';
      if (/power/i.test(after)) return 'POWER';
      if (/chilled/i.test(after)) return 'CHILL';
      if (/classical/i.test(after)) return 'CLASSIC';
      if (/front/i.test(after)) return 'FRONT';
      if (/party/i.test(after)) return 'PARTY';
      if (/rock/i.test(after)) return 'ROCK';
      if (/jammin/i.test(after)) return 'JAMMIN';
      if (/lite/i.test(after)) return 'LITE';
      if (/soul/i.test(after)) return 'SOUL';
      if (/energy|nrg/i.test(after)) return 'NRG 98';
      const subWords = after.split(/\s+/).filter(w => !['the', 'a'].includes(w.toLowerCase()));
      return (subWords[0] || '181').slice(0, 6).toUpperCase();
    }

    // Specific Brands & Series
    if (/Greatest\s*Hits/i.test(clean)) {
      if (/60/i.test(clean)) return 'GHR 60';
      if (/70/i.test(clean)) return 'GHR 70';
      if (/80/i.test(clean)) return 'GHR 80';
      return 'GHR';
    }
    if (/Absolute\s*Radio/i.test(clean) || /Absolute/i.test(clean)) {
      if (/60/i.test(clean)) return 'ABS 60';
      if (/70/i.test(clean)) return 'ABS 70';
      if (/80/i.test(clean)) return 'ABS 80';
      if (/90/i.test(clean)) return 'ABS 90';
      if (/00/i.test(clean)) return 'ABS 00';
      if (/10/i.test(clean)) return 'ABS 10';
      if (/classic/i.test(clean)) return 'ABS CR';
      return 'ABS';
    }
    if (/Radio\s*X/i.test(clean)) {
      if (/manchester/i.test(clean)) return 'RAD X';
      if (/classic/i.test(clean)) return 'RAD X';
      if (/90/i.test(clean)) return 'RAD 90';
      if (/chill/i.test(clean)) return 'RAD X';
      return 'RADIO X';
    }
    if (/Heart\s*Dance/i.test(clean)) return 'HRT DN';
    if (/Heart\s*70/i.test(clean)) return 'HRT 70';
    if (/Heart\s*80/i.test(clean)) return 'HRT 80';
    if (/Heart\s*90/i.test(clean)) return 'HRT 90';
    if (/Heart\s*00/i.test(clean)) return 'HRT 00';
    if (/Heart\s*10/i.test(clean)) return 'HRT 10';
    if (/Heart/i.test(clean)) return 'HEART';
    if (/KISSTORY/i.test(clean)) {
      if (/r&b|rnb/i.test(clean)) return 'KS R&B';
      return 'KISSTOR';
    }
    if (/KISS\s*Dance/i.test(clean)) return 'KISS DN';
    if (/KISS\s*XTRA/i.test(clean)) return 'KISS XT';
    if (/KISS\s*108/i.test(clean)) return 'KISS 108';
    if (/KISS/i.test(clean)) {
      if (/espa/i.test(clean)) return 'KISS ES';
      return 'KISS';
    }
    if (/Capital\s*Dance/i.test(clean)) return 'CAP DN';
    if (/Capital\s*XTRA/i.test(clean)) return 'CAP XT';
    if (/Capital/i.test(clean)) return 'CAPITAL';
    if (/Smooth\s*Chill/i.test(clean)) return 'SMOOTH';
    if (/Smooth/i.test(clean)) return 'SMOOTH';
    if (/Classic\s*FM/i.test(clean)) return 'CLASSIC';
    if (/Gold\s*Radio/i.test(clean) || clean === 'Gold') return 'GOLD';
    if (/LBC/i.test(clean)) return 'LBC';
    if (/Radio\s*Caroline/i.test(clean)) {
      if (/flashback/i.test(clean)) return 'FLASH';
      if (/north/i.test(clean)) return 'CAROL';
      return 'CAROL';
    }
    if (/Big\s*R\s*Radio/i.test(clean)) {
      if (/70/i.test(clean)) return 'BIG R 70';
      if (/80/i.test(clean)) return 'BIG R 80';
      return 'BIG R';
    }
    if (/Urban\s*Radio/i.test(clean)) {
      if (/hip\s*hop/i.test(clean)) return 'URBAN HH';
      if (/r&b/i.test(clean)) return 'URB R&B';
      return 'URBAN';
    }
    if (/Classic\s*Hits\s*109/i.test(clean)) {
      if (/soft/i.test(clean)) return 'CH109 SR';
      return 'CH109';
    }
    if (/100hitz/i.test(clean)) return '100 HITZ';
    if (/2000\s*FM/i.test(clean)) return '2000 FM';
    if (/011\.FM/i.test(clean)) return '011.FM';
    if (/KC101/i.test(clean)) return 'KC101';
    if (/Z100/i.test(clean)) return 'Z100';
    if (/KIIS/i.test(clean)) return 'KIIS';
    if (/Virgin/i.test(clean)) return 'VIRGIN';
    if (/KEXP/i.test(clean)) return 'KEXP';
    if (/NPR/i.test(clean)) return 'NPR';
    if (/WQXR/i.test(clean)) return 'WQXR';
    if (/WNYC/i.test(clean)) return 'WNYC';
    if (/WFUV/i.test(clean)) return 'WFUV';
    if (/KCRW/i.test(clean)) return 'KCRW';
    if (/Defected/i.test(clean)) return 'DEFECT';
    if (/Ibiza\s*Global/i.test(clean)) return 'IBZ GLB';
    if (/Ibiza\s*Sonica/i.test(clean)) return 'IBZ SON';
    if (/SomaFM|Soma\s*FM/i.test(clean)) {
      const after = clean.replace(/SomaFM\s*[-–:]?\s*/i, '').trim();
      if (/groove/i.test(after)) return 'GROOVE';
      if (/drone/i.test(after)) return 'DRONE';
      if (/indie/i.test(after)) return 'INDIE';
      if (/secret/i.test(after)) return 'SECRET';
      if (/lush/i.test(after)) return 'LUSH';
      return (after.slice(0, 6) || 'SOMA').toUpperCase();
    }
    if (/FIP/i.test(clean)) return 'FIP';
    if (/TSF\s*Jazz/i.test(clean)) return 'TSF';
    if (/Radio\s*Nova/i.test(clean)) return 'NOVA';
    if (/Radio\s*Swiss\s*Jazz/i.test(clean)) return 'SWISS JZ';
    if (/Radio\s*Swiss\s*Classic/i.test(clean)) return 'SWISS CL';
    if (/Radio\s*Swiss\s*Pop/i.test(clean)) return 'SWISS PP';
    if (/FluxFM|Flux\s*FM/i.test(clean)) return 'FLUX';
    if (/EgoFM|egoFM/i.test(clean)) return 'EGO';
    if (/Sunshine\s*Live/i.test(clean)) return 'SUNSHIN';
    if (/Antenne\s*Bayern/i.test(clean)) return 'BAYERN';
    if (/1Live|1\s*Live/i.test(clean)) return '1LIVE';
    if (/WDR/i.test(clean)) return 'WDR';
    if (/SWR3|SWR/i.test(clean)) return 'SWR3';
    if (/Bayern\s*3/i.test(clean)) return 'BAYERN 3';
    if (/RTL/i.test(clean)) return 'RTL';
    if (/NRJ/i.test(clean)) return 'NRJ';
    if (/Cherie|Chrie/i.test(clean)) return 'CHERIE';
    if (/Nostalgie/i.test(clean)) return 'NOSTAL';
    if (/Fun\s*Radio/i.test(clean)) return 'FUN RD';
    if (/Skyrock/i.test(clean)) return 'SKYROCK';
    if (/Cadena\s*SER|SER/i.test(clean)) return 'SER';
    if (/Cadena\s*Dial|Dial/i.test(clean)) return 'DIAL';
    if (/Cadena\s*100/i.test(clean)) return 'CAD 100';
    if (/Radio\s*3/i.test(clean)) return 'RNE 3';
    if (/Radio\s*1/i.test(clean)) return 'RNE 1';
    if (/Onda\s*Cero/i.test(clean)) return 'ONDA';
    if (/Cope/i.test(clean)) return 'COPE';
    if (/Dance\s*Wave/i.test(clean)) return 'DANCE';
    if (/Q102/i.test(clean)) return 'Q102';
    if (/Y100/i.test(clean)) return 'Y100';
    if (/Channel\s*955/i.test(clean)) return 'CH 955';
    if (/Mega\s*97\.9/i.test(clean)) return 'MEGA';
    if (/Mega\s*96\.3/i.test(clean)) return 'MEGA';
    if (/El\s*Zol/i.test(clean)) return 'EL ZOL';
    if (/Amor\s*93\.1/i.test(clean)) return 'AMOR';
    if (/Neon\s*Radio/i.test(clean)) return 'NEON';
    if (/Like\s*Radio/i.test(clean)) return 'LIKE';
    if (/HITS\s*96\.1/i.test(clean)) return 'HITS 96';
    if (/WiLD\s*95\.5/i.test(clean)) return 'WiLD';
    if (/Alice\s*95\.5/i.test(clean)) return 'ALICE';
    if (/POP!?\s*93\.3/i.test(clean)) return 'POP!';
    if (/Pop!?\s*93\.1/i.test(clean)) return 'POP!';
    if (/KGAY/i.test(clean)) return 'KGAY';
    if (/WDJQ/i.test(clean)) return 'WDJQ';
    if (/KLTG/i.test(clean)) return 'KLTG';
    if (/KEOM/i.test(clean)) return 'KEOM';
    if (/Love\s*92\.1/i.test(clean)) return 'LOVE';
    if (/KCWU/i.test(clean)) return 'KCWU';
    if (/KIXY/i.test(clean)) return 'KIXY';
    if (/KVUU/i.test(clean)) return 'KVUU';
    if (/The\s*Beat/i.test(clean)) return 'BEAT';
    if (/WKRD/i.test(clean)) return 'WKRD';
    if (/WZBQ|ZBQ/i.test(clean)) return 'ZBQ';
    if (/NOW/i.test(clean)) return 'NOW';

    // Generic frequency check
    const freqMatch = clean.match(/\b\d{2,3}(?:\.\d)?\b/);
    const words = clean.split(/\s+/).filter(w => !['radio', 'the', 'of', 'uk', 'fm', 'am', 'live', 'רדיו', 'שידור'].includes(w.toLowerCase()));

    if (freqMatch && words.length > 0 && !words[0].includes(freqMatch[0])) {
      return (words[0].slice(0, 4) + ' ' + freqMatch[0]).trim();
    }
    if (freqMatch) return freqMatch[0] + ' FM';

    if (words.length >= 2) {
      return (words[0].slice(0, 4) + ' ' + words[1].slice(0, 3)).trim().toUpperCase();
    }
    if (words.length === 1) return words[0].slice(0, 6).toUpperCase();
    return clean.slice(0, 6).toUpperCase();
  }

  /** Generate an automotive-style gradient based on station name */
  function getStationGradient(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const gradients = [
      'linear-gradient(135deg, #1e3a8a, #0284c7)', // Cobalt / Cyan
      'linear-gradient(135deg, #4c1d95, #7c3aed)', // Purple
      'linear-gradient(135deg, #064e3b, #059669)', // Emerald
      'linear-gradient(135deg, #78350f, #d97706)', // Amber / Gold
      'linear-gradient(135deg, #831843, #db2777)', // Crimson / Rose
      'linear-gradient(135deg, #0f766e, #06b6d4)', // Teal
      'linear-gradient(135deg, #312e81, #4f46e5)', // Deep Indigo
      'linear-gradient(135deg, #1e293b, #475569)', // Carbon Slate
    ];
    return gradients[Math.abs(hash) % gradients.length];
  }

  /** Glow color matching the station gradient (used for the hero background) */
  function getStationGlow(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const glows = [
      'rgba(2, 132, 199, 0.30)', 'rgba(124, 58, 237, 0.30)', 'rgba(5, 150, 105, 0.30)', 'rgba(217, 119, 6, 0.28)',
      'rgba(219, 39, 119, 0.28)', 'rgba(6, 182, 212, 0.28)', 'rgba(79, 70, 229, 0.30)', 'rgba(71, 85, 105, 0.32)'
    ];
    return glows[Math.abs(hash) % glows.length];
  }

  /** Refresh the "Now Playing" hero from current state */
  function updateHero() {
    if (!heroEl) return;
    const st = currentStation;

    if (!st) {
      if (heroKicker) heroKicker.textContent = 'READY TO PLAY';
      if (heroTitle) heroTitle.textContent = 'Pick a station to start';
      if (heroSub) heroSub.textContent = 'Curated live radio. No accounts, no ads added.';
      if (heroPlayLabel) heroPlayLabel.textContent = 'Play';
      return;
    }

    const mono = getStationMonogram(st.name);
    if (heroArt) {
      heroArt.style.background = getStationGradient(st.name);
      heroArt.style.setProperty('--ms', mono.length > 6 ? '0.66' : (mono.length > 5 ? '0.76' : (mono.length > 3 ? '0.9' : '1')));
      heroArt.innerHTML = `<span class="hero-mono">${escapeHtml(mono)}</span><span class="hero-flag">${escapeHtml(st.flag || '')}</span>`;
    }
    heroEl.style.setProperty('--hero-glow', getStationGlow(st.name));

    if (heroTitle) heroTitle.textContent = currentTrackTitle || st.name;
    if (heroSub) {
      heroSub.textContent = currentTrackTitle
        ? `${st.name} • ${shortCountry(st.country)}`
        : `${st.flag || '📻'} ${shortCountry(st.country)} • Live stream`;
    }

    if (heroKicker) {
      if (streamOffline) heroKicker.textContent = 'STREAM OFFLINE';
      else if (isBuffering) heroKicker.textContent = 'CONNECTING...';
      else if (isPlaying) heroKicker.textContent = 'NOW PLAYING';
      else if (lastStartAt === 0) heroKicker.textContent = 'READY TO PLAY';
      else heroKicker.textContent = 'PAUSED';
    }

    if (heroPlayLabel) heroPlayLabel.textContent = isPlaying ? 'Pause' : 'Play';
    if (heroPlayBtn) {
      const ic = heroPlayBtn.querySelector('.hero-play-icon');
      if (ic) ic.innerHTML = iconSvg(isPlaying ? 'i-pause' : 'i-play');
    }
    if (heroFavBtn) {
      const fav = favorites.has(st.id);
      heroFavBtn.classList.toggle('favorited', fav);
      heroFavBtn.innerHTML = heartSvg(fav);
      heroFavBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
    }
  }

  /** Render station cards in grid */
  function renderStations() {
    if (!stationsGrid) return;

    if (filteredStations.length === 0) {
      stationsGrid.innerHTML = '';
      if (emptyState) emptyState.style.display = 'block';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    stationsGrid.innerHTML = filteredStations.map((st, idx) => {
      const isFav = favorites.has(st.id);
      const isCurr = currentStation && currentStation.id === st.id;
      const activeClass = isCurr ? 'active-playing' : '';
      const favClass = isFav ? 'favorited' : '';
      const flag = st.flag || '📻';
      const tagList = Array.isArray(st.tags) ? st.tags : (st.tags ? String(st.tags).split(',') : []);
      const rawGenre = tagList[0] ? tagList[0].trim() : shortCountry(st.country);
      const genre = rawGenre ? (rawGenre.charAt(0).toUpperCase() + rawGenre.slice(1)) : 'Live';

      const monogram = getStationMonogram(st.name);
      const bgGrad = getStationGradient(st.name);
      const subLabel = st.flag || st.countryCode || 'LIVE';
      const monoFontSize = monogram.length > 6 ? '9.5px' : (monogram.length > 5 ? '10.5px' : (monogram.length > 3 ? '12px' : '14px'));
      const safeName = escapeHtml(st.name);
      const safeId = escapeHtml(st.id);

      const artHtml = `
        <div class="card-art-badge" style="background: ${bgGrad}">
          <span class="card-badge-monogram" style="font-size: ${monoFontSize};">${escapeHtml(monogram)}</span>
          <span class="card-badge-country">${escapeHtml(subLabel)}</span>
        </div>
        <div class="card-play-overlay" aria-hidden="true">${iconSvg('i-play')}</div>
        <span class="card-eq" aria-hidden="true"><i></i><i></i><i></i></span>
      `;

      const isBlockedMood = (currentMood === 'BLOCKED');
      const actionHtml = isBlockedMood ? `
        <div class="card-actions-group">
          <button class="card-unblock-btn" title="Unblock Station" aria-label="Unblock ${safeName}" data-unblockid="${safeId}">
            <span>✓</span> Unblock
          </button>
        </div>
      ` : `
        <div class="card-actions-group">
          <button class="card-fav-btn ${favClass}" title="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${isFav ? 'Remove' : 'Add'} ${safeName} ${isFav ? 'from' : 'to'} favorites" aria-pressed="${isFav ? 'true' : 'false'}" data-favid="${safeId}">
            ${heartSvg(isFav)}
          </button>
          <button class="card-block-btn" title="Block Station" aria-label="Block ${safeName}" data-blockid="${safeId}">
            ${iconSvg('i-block')}
          </button>
        </div>
      `;

      return `
        <div class="station-card ${activeClass}" data-id="${safeId}" data-idx="${idx}" role="button" tabindex="0" aria-label="${isCurr ? 'Pause or resume' : 'Play'} ${safeName}">
          <div class="card-art-box">
            ${artHtml}
          </div>
          <div class="card-details">
            <div class="card-title">${safeName}</div>
            <div class="card-meta">
              <span>${escapeHtml(flag)}</span>
              <span>•</span>
              <span>${escapeHtml(genre)}</span>
            </div>
          </div>
          ${actionHtml}
        </div>
      `;
    }).join('');
  }

  /** One delegated handler for all cards (no per-render listener buildup) */
  function handleGridActivate(e) {
    const unblockBtn = e.target.closest('.card-unblock-btn');
    if (unblockBtn) {
      e.stopPropagation();
      const id = unblockBtn.getAttribute('data-unblockid');
      if (id) unblockStation(id);
      return;
    }
    const blockBtn = e.target.closest('.card-block-btn');
    if (blockBtn) {
      e.stopPropagation();
      const id = blockBtn.getAttribute('data-blockid');
      if (id) blockStation(id);
      return;
    }
    const favBtn = e.target.closest('.card-fav-btn');
    if (favBtn) {
      e.stopPropagation();
      const id = favBtn.getAttribute('data-favid');
      if (id) toggleFavorite(id);
      return;
    }
    const card = e.target.closest('.station-card');
    if (!card) return;
    const id = card.getAttribute('data-id');
    const st = stations.find(s => s.id === id);
    if (st) {
      if (currentStation && currentStation.id === st.id) {
        togglePlayPause();
      } else {
        playStation(st);
      }
    }
  }

  function blockStation(id) {
    if (!id) return;
    const wasIdx = currentIndex;
    blockedStations.add(id);
    const serialized = JSON.stringify([...blockedStations]);
    localStorage.setItem(LS_BLOCKED, serialized);
    localStorage.setItem('drivewave_web_blocked', serialized);
    updateBadges();
    applyFilter();
    if (currentStation && currentStation.id === id) {
      localStorage.removeItem(LS_LAST_STATION);
      localStorage.removeItem('drivewave_web_last_station');
      if (filteredStations.length > 0) {
        if (isShuffle && filteredStations.length > 1) {
          playNext(false); // not user-debounced: a block must always move on, even right after a skip
        } else {
          // The station that slid into the blocked one's slot is the natural "next"
          playStation(filteredStations[Math.min(Math.max(wasIdx, 0), filteredStations.length - 1)], false);
        }
      } else {
        stopPlaybackCompletely();
      }
    }
    showToast('Station blocked. You can unblock it from the Block List.');
  }

  /** Stop audio and release the stream (used when nothing is left to play) */
  function stopPlaybackCompletely() {
    stopIcyMetadataReader();
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) {}
      hlsInstance = null;
    }
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {}
    setBuffering(false);
    updatePlaybackState(false);
  }

  function unblockStation(id) {
    if (!id) return;
    blockedStations.delete(id);
    const serialized = JSON.stringify([...blockedStations]);
    localStorage.setItem(LS_BLOCKED, serialized);
    localStorage.setItem('drivewave_web_blocked', serialized);
    updateBadges();
    applyFilter();
  }

  function unblockAll() {
    if (blockedStations.size === 0) return;
    blockedStations.clear();
    localStorage.setItem(LS_BLOCKED, JSON.stringify([]));
    localStorage.setItem('drivewave_web_blocked', JSON.stringify([]));
    updateBadges();
    applyFilter();
  }

  function updateActiveStationCard() {
    if (!stationsGrid) return;
    const prevActive = stationsGrid.querySelectorAll('.station-card.active-playing');
    prevActive.forEach(el => el.classList.remove('active-playing'));
    if (currentStation) {
      const currentEl = Array.from(stationsGrid.querySelectorAll('.station-card')).find(el => el.getAttribute('data-id') === currentStation.id);
      if (currentEl) {
        currentEl.classList.add('active-playing');
      }
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resetTrackState(station) {
    stopIcyMetadataReader();
    stopSyncAnimation();
    currentTrackTitle = '';
    resetLyricsSyncForNewStream();

    const stName = station ? station.name : '';
    if (playerTrack) {
      playerTrack.textContent = stName;
      playerTrack.title = stName;
    }
    if (dmTrackTitle) dmTrackTitle.textContent = stName;
    if (miniTitle) miniTitle.textContent = stName;

    // Reset Lyrics UI state immediately
    if (lyricsOverlay) {
      if (lyricsTrackName) lyricsTrackName.textContent = stName || 'Live Radio';
      if (lyricsArtistName) lyricsArtistName.textContent = 'Live Broadcast';
      const searchInput = document.getElementById('lyrics-search-input');
      if (searchInput && document.activeElement !== searchInput) searchInput.value = '';
      setBadge('', '');
      setHint('');
      if (lyricsSyncControls) lyricsSyncControls.style.display = 'none';
      if (lyricsFooter) lyricsFooter.style.display = 'none';
      if (lyricsContent) {
        lyricsContent.innerHTML = `
          <div class="lyrics-no-results">
            <span class="lyrics-no-icon">📻</span>
            Listening to <strong>${escapeHtml(stName || 'Live Radio')}</strong><br>
            <span style="font-size: 13px; color: var(--text-muted); margin-top: 8px; display: block;">
              Waiting for live song broadcast info...<br>
              Or search lyrics for any song above 🔍
            </span>
          </div>`;
      }
      if (lyricsLoading) lyricsLoading.style.display = 'none';
    }
    updateHero();
  }

  /** Set Station in UI without necessarily playing */
  function setStationUI(station, shouldPlay = false) {
    currentStation = station;
    currentIndex = filteredStations.findIndex(s => s.id === station.id);
    streamOffline = false;
    resetTrackState(station);

    const artUrl = station.favicon || 'icon-512.png';
    if (playerArt) playerArt.src = artUrl;
    if (dmArtwork) dmArtwork.src = artUrl;
    if (miniArt) miniArt.src = artUrl;

    const subtitleText = `${station.flag || '📻'} ${shortCountry(station.country)} • Live Stream`;
    if (playerStation) {
      playerStation.innerHTML = `<span>📻</span> <span>${escapeHtml(subtitleText)}</span>`;
    }
    if (dmStationName) {
      dmStationName.textContent = subtitleText;
    }
    if (miniSub) {
      miniSub.textContent = subtitleText;
    }

    if (favPlayerBtn) {
      const isFav = favorites.has(station.id);
      favPlayerBtn.classList.toggle('favorited', isFav);
      favPlayerBtn.innerHTML = heartSvg(isFav);
    }

    localStorage.setItem(LS_LAST_STATION, station.id);

    updateDocumentPipUI();
    renderVideoPipFrame();
    updateActiveStationCard();
    updateHero();

    if (shouldPlay) {
      startAudio(station);
    }
  }

  /** Play a station with history tracking */
  function playStation(station, recordHistory = true) {
    if (!station) return;
    if (recordHistory && currentStation && currentStation.id !== station.id) {
      playbackHistory.push(currentStation.id);
      if (playbackHistory.length > MAX_HISTORY) playbackHistory.shift();
    }
    retryCount = 0;
    setStationUI(station, true);
  }

  let icyAbortController = null;
  let currentTrackTitle = '';

  function cleanStreamTitle(raw) {
    if (!raw) return "";
    let text = raw.trim();
    if (!text) return "";

    // 1. Extract content inside StreamTitle='...' or StreamTitle="..." or StreamTitle=...
    const streamTitleQuoted = text.match(/^StreamTitle\s*[:=]\s*(['"])(.*?)\1\s*;?$/is);
    if (streamTitleQuoted) {
      text = streamTitleQuoted[2].trim();
    } else {
      text = text.replace(/^StreamTitle\s*[:=]\s*(.*?)(?:;.*)?$/is, '$1').trim();
    }

    // iHeart style: title="Song",artist="Artist",url="...". This must be read BEFORE the generic prefix
    // stripper below, which would swallow the title= key and leave the rest of the string as junk.
    const kvEarly = text.match(/^(?:title|song)\s*=\s*(['"])(.*?)\1\s*,\s*artist\s*=\s*(['"])(.*?)\3/is);
    if (kvEarly) {
      const t = kvEarly[2].trim();
      const a = kvEarly[4].trim();
      text = (t && a) ? `${a} - ${t}` : (t || a);
    } else {
      // Strip prefixes like TITLE=, TEXT=, SONG=, TRACK= if whole string begins with them
      text = text.replace(/^(?:TEXT|TITLE|SONG|TRACK)\s*[:=]\s*(['"]?)(.*?)\1\s*;?$/is, '$2').trim();
    }

    // Strip enclosing outer quotes ONLY if both ends match
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
    }

    // 2. Key-value format check:
    const titleMatch = text.match(/(?:^|[,;\s])(?:title|song)\s*=\s*(['"])(.*?)\1/i);
    const artistMatch = text.match(/(?:^|[,;\s])artist\s*=\s*(['"])(.*?)\1/i);
    const spotRegex = /spot\s*block|commercial|ad\s*break|station\s*id|sweeper|promo/i;

    let effectiveTitleMatch = titleMatch;
    if (!effectiveTitleMatch) {
      const tm = text.match(/(?:^|[,;\s])text\s*=\s*(['"])(.*?)\1/i);
      if (tm && !spotRegex.test(tm[2])) {
        effectiveTitleMatch = tm;
      }
    }

    if (effectiveTitleMatch && artistMatch) {
      const t = effectiveTitleMatch[2].trim().replace(/^['"]+|['"]+$/g, '');
      const a = artistMatch[2].trim().replace(/^['"]+|['"]+$/g, '');
      if (t && a) {
        text = `${a} - ${t}`;
      }
    } else {
      // Check prefix artist before "- text=..." e.g. 'Teddy Swims - text="The Door" amgTrackId="123"'
      const prefixArtistMatch = text.match(/^(.*?)\s*-\s*(?:text|title|song)\s*=\s*(['"])(.*?)\2/i);
      if (prefixArtistMatch) {
        const a = prefixArtistMatch[1].trim();
        const t = prefixArtistMatch[3].trim().replace(/^['"]+|['"]+$/g, '');
        if (a && t && !spotRegex.test(t)) {
          text = `${a} - ${t}`;
        }
      }
    }

    // 3. Strip all broadcast metadata key-value parameters
    const paramRegex = /[,;]?\s*\b(?:amgTrackId|itunesTrackId|MediaBaseId|cartcutId|song_spot|length|time|uid|buyurl|StreamUrl|url|artist|title|album|song|text|label|genre)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi;
    text = text.replace(paramRegex, '').trim();

    // 4. Filter out commercials, promos, station bumpers, spot blocks
    const promoRegex = /^(?:-\s*)?(?:spot\s*block.*|commercial.*|(?:stop\s*|start\s*)?ad\s*-?\s*break.*|ad\s*\d+|station\s*id.*|sweeper.*|jingle.*|promo.*|.*\bpreset\s*\d+.*|.*#1\s+(?:hit\s+)?music\s+station.*|unknown|no\s*title|live\s*stream)$/i;
    if (promoRegex.test(text.trim())) {
      return "";
    }

    // 5. Replace underscores with spaces (e.g. things_i_dont_regret or Artist_Name)
    text = text.replace(/_/g, ' ');

    // 6. Strip technical tags & file suffixes (fgmstr4416, fgmstr, mstr, cartcut, etc.)
    text = text.replace(/\b(?:fgmstr|mstr|cartcut)\d*\b/gi, '');
    text = text.replace(/\b\d+(?:kbps|khz)\b/gi, '');
    text = text.replace(/\b(?:cbr|vbr)\d*\b/gi, '');
    text = text.replace(/\.(?:mp3|m4a|aac|wav|flac|ogg)\b/gi, '');

    // 7. Strip common redundant prefixes
    text = text.replace(/^(?:NOW PLAYING|NOW ON AIR|LIVE|NP):\s*/i, '');
    text = text.replace(/^\s*(?:text|title|song|track)\s*[:=]\s*/i, '');

    // 8. Strip video / quality / edition clutter in brackets/parentheses
    text = text.replace(/\s*[\[(]\s*(?:official\s+(?:audio|video|music\s+video)|lyrics?|visualizer|hd|hq)\s*[\])]/gi, '');
    text = text.replace(/\s*[\[(]\s*(?:clean(?:\s+version)?|radio\s+edit)\s*[\])]/gi, '');

    // 9. Normalize multiple spaces & dashes
    text = text.replace(/\s*[\u2013\u2014]\s*|\s+--\s+/g, ' - ');
    text = text.replace(/\s+-\s+/g, ' - ');

    // Check for "Song by Artist"
    if (!text.includes(' - ')) {
      const byMatch = text.match(/^(.*?)\s+by\s+(.*)$/i);
      if (byMatch) {
        const song = byMatch[1].trim();
        const artist = byMatch[2].trim();
        if (song && artist) {
          text = `${artist} - ${song}`;
        }
      } else {
        const sepMatch = text.match(/^(.*?)\s+[:|/]\s+(.*)$/);
        if (sepMatch) {
          const p1 = sepMatch[1].trim();
          const p2 = sepMatch[2].trim();
          if (p1 && p2) {
            text = `${p1} - ${p2}`;
          }
        }
      }
    }

    text = text.replace(/\s{2,}/g, ' ').trim();
    text = text.replace(/^['"`\s-,.;]+|['"`\s-,.;]+$/g, '');

    if (text.length < 2 || text === '-') {
      return "";
    }

    return text;
  }

  function onNewTrackInfo(track, station) {
    if (!track) return;
    // Guard against delayed stream packets from previous station
    if (station && currentStation && station.id !== currentStation.id) return;
    if (track === currentTrackTitle) return;

    // Filter out if metadata is just the station name or station slogan
    if (station) {
      const normTrack = track.toLowerCase().trim();
      const normStation = station.name.toLowerCase().trim();
      if (normTrack === normStation) return;
      if (normTrack.includes(normStation) && normTrack.length < normStation.length + 6) return;
    }

    currentTrackTitle = track;
    // Record WHEN this song starts on the media timeline (and whether we witnessed it)
    const anchor = syncEngine ? syncEngine.onTrack(track, mediaNowSec() + bufferLeadSec()) : null;
    // Auto-refresh lyrics if the modal is open (a re-announced same song keeps its lyrics)
    if (lyricsVisible && !(anchor && anchor.refinement)) {
      loadLyricsForTrack(track);
    }

    // Update Player Bar
    if (playerTrack) {
      playerTrack.textContent = track;
      playerTrack.title = track;
    }
    if (playerStation && station) {
      playerStation.innerHTML = `<span>📻</span> <span>${escapeHtml(station.name)} • Live</span>`;
    }

    // Update Cockpit Driving Mode
    if (dmTrackTitle) dmTrackTitle.textContent = track;
    if (dmStationName && station) dmStationName.textContent = station.name;

    // Update Mini Player
    if (miniTitle) miniTitle.textContent = track;
    if (miniSub && station) miniSub.textContent = station.name;

    // Update MediaSession
    updateMediaSession(station, track);

    // Update PiP, hero and Tab Title
    updateDocumentPipUI();
    renderVideoPipFrame();
    updateHero();
    updateTabTitle();
  }

  // ============================================================
  // Lyrics Module — LRCLib lookup + confidence-based sync (engine: lyrics-sync.js)
  // "Synced" is only ever shown when the song start was actually witnessed and the lyrics were
  // matched to the live track with high confidence. Everything else is labelled honestly.
  // ============================================================

  const LyricsSync = window.AutoWaveLyricsSync || null;
  const syncEngine = LyricsSync ? new LyricsSync.SyncEngine() : null;

  let lyricsOverlay = null;
  let lyricsBody = null;
  let lyricsContent = null;
  let lyricsLoading = null;
  let lyricsTrackName = null;
  let lyricsArtistName = null;
  let lyricsStateBadge = null;
  let lyricsHint = null;
  let lyricsFooter = null;
  let lyricsVisible = false;
  let lyricsAnimFrame = null;
  let lyricsLines = []; // [{time: seconds, el: DOMElement}] for synced lyrics
  let lyricsLastActiveIdx = -1;
  let lyricsCurrentTrack = ''; // track we last fetched for
  let lyricsLoadToken = 0;
  let lyricsStatusSig = '';
  let lyricsSyncControls = null;
  let btnSyncMinus = null;
  let btnSyncPlus = null;
  let syncOffsetVal = null;

  /** Media-timeline second the playhead is at (immune to stalls and pauses, unlike wall-clock). */
  function mediaNowSec() {
    return audio.currentTime || 0;
  }

  /**
   * How far ahead of the playhead the metadata connection is. A title that arrives now belongs to a
   * song that begins this many seconds from the playhead (the buffered-but-unplayed audio).
   */
  function bufferLeadSec() {
    try {
      const b = audio.buffered;
      if (b && b.length) {
        const lead = b.end(b.length - 1) - audio.currentTime;
        if (Number.isFinite(lead) && lead >= 0 && lead < 60) return lead;
      }
    } catch (e) { /* fall through */ }
    return 2; // typical decode + buffer latency when the browser does not expose it
  }

  /** Called for every genuinely new live title: records WHEN the song starts on the media timeline. */
  function anchorLyricsToTrack(track) {
    if (!syncEngine) return;
    syncEngine.onTrack(track, mediaNowSec() + bufferLeadSec());
  }

  function resetLyricsSyncForNewStream() {
    if (syncEngine) syncEngine.resetStream();
    lyricsLoadToken++;          // drop any in-flight lookup for the previous stream
    lyricsCurrentTrack = '';
    lyricsLines = [];
    lyricsLastActiveIdx = -1;
    lyricsStatusSig = '';
  }

  function setBadge(text, cls) {
    if (!lyricsStateBadge) return;
    lyricsStateBadge.textContent = text;
    lyricsStateBadge.className = 'lyrics-state-badge ' + cls;
    lyricsStateBadge.style.display = text ? '' : 'none';
  }

  function setHint(text) {
    if (!lyricsHint) return;
    lyricsHint.textContent = text || '';
    lyricsHint.style.display = text ? '' : 'none';
  }

  /** Reflects the engine's verdict in the badge, hint and nudge controls (only when it changes). */
  function applySyncStatusUi(res) {
    const S = LyricsSync.STATUS;
    const sig = res.status + '|' + res.trusted;
    if (sig === lyricsStatusSig) return;
    lyricsStatusSig = sig;

    const canNudge = res.status === S.SYNCED || res.status === S.MANUAL;
    if (lyricsSyncControls) lyricsSyncControls.style.display = canNudge ? 'flex' : 'none';

    switch (res.status) {
      case S.SYNCED:
        setBadge(res.trusted ? '⏱ Synced ✓' : '⏱ Synced', 'is-synced');
        setHint('');
        break;
      case S.MANUAL:
        setBadge('👆 Synced by you', 'is-manual');
        setHint('');
        break;
      case S.WAITING:
        setBadge('⏳ Not synced yet', 'is-waiting');
        setHint(res.reason === 'tap the line you hear to sync'
          ? 'Tap the line you are hearing to sync these lyrics.'
          : 'You joined mid-song, so the exact position is unknown. Lyrics sync automatically when the next song starts, or tap the line you hear.');
        break;
      case S.LOST:
        setBadge('Sync lost', 'is-lost');
        setHint('This song ran longer than expected. Tap a line to re-sync, or wait for the next song.');
        break;
      case S.UNVERIFIED:
        setBadge('Unverified match', 'is-unverified');
        setHint('These lyrics may be for a different version of the song, so they are not auto-synced. Tap the line you hear to sync.');
        break;
      case S.PLAIN:
        setBadge('Plain lyrics', 'is-plain');
        setHint('Timed lyrics are not available for this song.');
        break;
      default:
        setBadge('', '');
        setHint('');
    }
  }

  function initLyricsElements() {
    lyricsOverlay = document.getElementById('lyrics-overlay');
    lyricsBody = document.getElementById('lyrics-body');
    lyricsContent = document.getElementById('lyrics-content');
    lyricsLoading = document.getElementById('lyrics-loading');
    lyricsTrackName = document.getElementById('lyrics-track-name');
    lyricsArtistName = document.getElementById('lyrics-artist-name');
    lyricsStateBadge = document.getElementById('lyrics-state-badge');
    lyricsHint = document.getElementById('lyrics-hint');
    lyricsFooter = document.getElementById('lyrics-footer');
    lyricsSyncControls = document.getElementById('lyrics-sync-controls');
    btnSyncMinus = document.getElementById('btn-sync-minus');
    btnSyncPlus = document.getElementById('btn-sync-plus');
    syncOffsetVal = document.getElementById('sync-offset-val');

    if (btnSyncMinus) {
      btnSyncMinus.addEventListener('click', (e) => {
        e.stopPropagation();
        if (syncEngine) syncEngine.nudge(-1.0);
        updateSyncOffsetDisplay();
      });
    }
    if (btnSyncPlus) {
      btnSyncPlus.addEventListener('click', (e) => {
        e.stopPropagation();
        if (syncEngine) syncEngine.nudge(1.0);
        updateSyncOffsetDisplay();
      });
    }
    if (syncOffsetVal) {
      syncOffsetVal.addEventListener('click', (e) => {
        e.stopPropagation();
        if (syncEngine) syncEngine.resetNudge();
        updateSyncOffsetDisplay();
      });
    }

    const btn = document.getElementById('btn-lyrics');
    const mobileBtn = document.getElementById('btn-lyrics-mobile');
    const dmBtn = document.getElementById('dm-btn-lyrics');
    const closeBtn = document.getElementById('btn-lyrics-close');

    if (btn) btn.addEventListener('click', openLyricsModal);
    if (mobileBtn) mobileBtn.addEventListener('click', openLyricsModal);
    if (dmBtn) dmBtn.addEventListener('click', openLyricsModal);
    if (closeBtn) closeBtn.addEventListener('click', closeLyricsModal);
    if (lyricsOverlay) {
      lyricsOverlay.addEventListener('click', (e) => {
        if (e.target === lyricsOverlay) closeLyricsModal();
      });
    }

    const searchInput = document.getElementById('lyrics-search-input');
    const searchBtn = document.getElementById('btn-lyrics-search');
    function triggerLyricsSearch() {
      const q = searchInput?.value?.trim();
      if (q) {
        loadLyricsForTrack(q, true);
      }
    }
    if (searchBtn) searchBtn.addEventListener('click', triggerLyricsSearch);
    if (searchInput) {
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          triggerLyricsSearch();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lyricsVisible) closeLyricsModal();
      if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') toggleLyricsModal();
      }
    });
  }

  /**
   * Looks the song up on LRCLIB with progressively wider queries, then lets the local matcher pick
   * the right entry. `failed` is true only when no request could be completed at all (offline).
   */
  async function fetchLyricCandidates(rawTrack) {
    const seen = new Set();
    const all = [];
    let okRequests = 0;
    for (const url of LyricsSync.buildQueries(rawTrack)) {
      try {
        let res = await fetch(url, { signal: timeoutSignal(8000) });
        // LRCLIB rate-limits bursts (429) and has the odd 5xx: one polite retry before giving up on this query
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, 1200));
          res = await fetch(url, { signal: timeoutSignal(8000) });
        }
        if (!res.ok) continue;
        const data = await res.json();
        okRequests++;
        if (Array.isArray(data)) {
          for (const c of data) {
            const key = c && c.id != null ? 'id' + c.id : [c && c.trackName, c && c.artistName, c && c.duration].join('|');
            if (!seen.has(key)) { seen.add(key); all.push(c); }
          }
        }
      } catch (e) { /* try the next query */ }
      const best = LyricsSync.chooseBest(rawTrack, all);
      if (best && best.verified && best.synced) break; // good enough, stop early
    }
    return { candidates: all, failed: okRequests === 0 };
  }

  function updateSyncOffsetDisplay() {
    const n = syncEngine ? syncEngine.nudgeSec : 0;
    if (syncOffsetVal) {
      syncOffsetVal.textContent = (n >= 0 ? '+' : '') + n.toFixed(1) + 's';
      syncOffsetVal.style.display = n !== 0 ? 'inline-block' : 'none';
    }
    lyricsLastActiveIdx = -1; // force immediate re-scroll to the active line
  }

  function renderSyncedLyrics(parsed) {
    lyricsContent.innerHTML = '';
    lyricsContent.className = 'lyrics-content';
    lyricsLines = [];
    lyricsStatusSig = '';
    updateSyncOffsetDisplay();

    for (const { time, text } of parsed) {
      const el = document.createElement('div');
      el.className = 'lyrics-line';
      el.textContent = text;
      el.title = 'Tap the line you are hearing to sync';
      el.addEventListener('click', () => {
        if (!syncEngine) return;
        // A human confirming "this is the line I hear right now" is the strongest sync signal there is
        syncEngine.manualSync(time, mediaNowSec());
        lyricsLastActiveIdx = -1;
        lyricsStatusSig = '';
        updateSyncOffsetDisplay();
      });
      lyricsContent.appendChild(el);
      lyricsLines.push({ time, el });
    }
    startSyncAnimation();
  }

  function renderPlainLyrics(textLines) {
    lyricsContent.innerHTML = '';
    lyricsContent.className = 'lyrics-content lyrics-plain';
    lyricsLines = [];
    for (const line of textLines) {
      const el = document.createElement('div');
      el.className = 'lyrics-line';
      el.textContent = line || ' ';
      lyricsContent.appendChild(el);
    }
    stopSyncAnimation();
    if (lyricsSyncControls) lyricsSyncControls.style.display = 'none';
    lyricsStatusSig = '';
    applySyncStatusUi({ status: LyricsSync.STATUS.PLAIN, trusted: false });
  }

  function renderNoResults(track, failed) {
    lyricsContent.innerHTML = `
      <div class="lyrics-no-results">
        <span class="lyrics-no-icon">🎵</span>
        ${failed ? 'Could not reach the lyrics service.<br>Check your connection and try again.' : 'No lyrics found for'}<br><strong>"${escapeHtml(track)}"</strong>
      </div>`;
    if (lyricsSyncControls) lyricsSyncControls.style.display = 'none';
    lyricsStatusSig = '';
    setBadge('', '');
    setHint('');
    stopSyncAnimation();
  }

  // A 250ms timer (not requestAnimationFrame): lyric lines change every few seconds, and a timer keeps
  // running in background tabs and embedded views where animation frames are suspended.
  function startSyncAnimation() {
    stopSyncAnimation();
    lyricsLastActiveIdx = -1;
    syncLyricsFrame();
    lyricsAnimFrame = setInterval(syncLyricsFrame, 250);
  }

  function stopSyncAnimation() {
    if (lyricsAnimFrame) {
      clearInterval(lyricsAnimFrame);
      lyricsAnimFrame = null;
    }
  }

  function syncLyricsFrame() {
    if (!lyricsVisible || lyricsLines.length === 0 || !syncEngine) {
      stopSyncAnimation();
      return;
    }
    const res = syncEngine.evaluate(mediaNowSec());
    applySyncStatusUi(res);

    // Highlight ONLY when the engine vouches for the position; otherwise show lyrics without a cursor
    const S = LyricsSync.STATUS;
    const activeIdx = (res.status === S.SYNCED || res.status === S.MANUAL) ? res.activeIndex : -1;
    if (activeIdx !== lyricsLastActiveIdx) {
      lyricsLastActiveIdx = activeIdx;
      lyricsLines.forEach(({ el }, idx) => {
        el.classList.toggle('active', idx === activeIdx);
        el.classList.toggle('passed', activeIdx >= 0 && idx < activeIdx);
      });
      if (activeIdx >= 0) {
        lyricsLines[activeIdx].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  /**
   * @param {string} track  live "Artist - Title", or the listener's manual search text
   * @param {boolean} manual true for a manual search: no live anchor exists, so only a tap can sync it
   */
  async function loadLyricsForTrack(track, manual = false) {
    if (!lyricsLoading || !lyricsContent || !syncEngine) return;
    const token = ++lyricsLoadToken;
    lyricsCurrentTrack = track;
    stopSyncAnimation();
    lyricsLoading.style.display = '';
    lyricsContent.innerHTML = '';
    if (lyricsSyncControls) lyricsSyncControls.style.display = 'none';
    setBadge('', '');
    setHint('');
    lyricsStatusSig = '';
    if (lyricsFooter) lyricsFooter.style.display = 'none';

    const searchInput = document.getElementById('lyrics-search-input');
    if (searchInput && document.activeElement !== searchInput) {
      searchInput.value = track;
    }

    const parsedQuery = LyricsSync.parseTrack(track);
    if (lyricsTrackName) lyricsTrackName.textContent = parsedQuery.title || track;
    if (lyricsArtistName) lyricsArtistName.textContent = parsedQuery.artist || '';

    const { candidates, failed } = await fetchLyricCandidates(track);
    // Guard: the track (or stream) changed while we were loading
    if (token !== lyricsLoadToken) return;

    lyricsLoading.style.display = 'none';
    if (lyricsFooter) lyricsFooter.style.display = '';

    const best = LyricsSync.chooseBest(track, candidates);
    if (!best) {
      syncEngine.setLyrics(null);
      renderNoResults(track, failed);
      return;
    }

    const cand = best.cand;
    // Show the matched song's real names when we trust the match (or the listener searched for it)
    if (best.verified || manual) {
      if (cand.trackName && lyricsTrackName) lyricsTrackName.textContent = cand.trackName;
      if (cand.artistName && lyricsArtistName) lyricsArtistName.textContent = cand.artistName;
    }

    const lines = best.synced ? LyricsSync.parseLrc(cand.syncedLyrics) : [];
    syncEngine.setLyrics({
      lines,
      durationSec: Number(cand.duration),
      verified: best.verified && !manual,
      plain: typeof cand.plainLyrics === 'string' ? cand.plainLyrics.split('\n') : [],
      manualOnly: !!manual
    });

    if (lines.length > 0) {
      renderSyncedLyrics(lines);
      return;
    }
    if (typeof cand.plainLyrics === 'string' && cand.plainLyrics.trim()) {
      renderPlainLyrics(cand.plainLyrics.split('\n'));
      return;
    }
    renderNoResults(track, false);
  }

  function openLyricsModal() {
    if (!lyricsOverlay) return;
    lyricsOverlay.classList.remove('hidden');
    lyricsVisible = true;
    const track = currentTrackTitle;
    if (track && track !== lyricsCurrentTrack) {
      loadLyricsForTrack(track);
    } else if (!track && !lyricsCurrentTrack) {
      if (lyricsLoading) lyricsLoading.style.display = 'none';
      setBadge('', '');
      setHint('');
      if (lyricsSyncControls) lyricsSyncControls.style.display = 'none';
      if (lyricsFooter) lyricsFooter.style.display = 'none';
      const stName = currentStation ? currentStation.name : 'Live Radio';
      if (lyricsTrackName) lyricsTrackName.textContent = stName;
      if (lyricsArtistName) lyricsArtistName.textContent = 'Live Broadcast';
      const searchInput = document.getElementById('lyrics-search-input');
      if (searchInput && !searchInput.value) searchInput.value = '';
      if (lyricsContent) {
        lyricsContent.innerHTML = `
          <div class="lyrics-no-results">
            <span class="lyrics-no-icon">📻</span>
            Listening to <strong>${escapeHtml(stName)}</strong><br>
            <span style="font-size: 13px; color: var(--text-muted); margin-top: 8px; display: block;">
              Waiting for live song broadcast info...<br>
              Or search lyrics for any song above 🔍
            </span>
          </div>`;
      }
    } else {
      // Resume the sync loop if lyrics are already on screen
      if (lyricsLines.length > 0) startSyncAnimation();
    }
  }

  function closeLyricsModal() {
    if (!lyricsOverlay) return;
    lyricsOverlay.classList.add('hidden');
    lyricsVisible = false;
    stopSyncAnimation();
  }

  function toggleLyricsModal() {
    if (lyricsVisible) closeLyricsModal();
    else openLyricsModal();
  }

  // ============================================================
  // Icecast ICY Metadata Reader for Non-HLS Live Streams
  // ============================================================
  let metadataAbortController = null;

  function stopIcyMetadataReader() {
    if (metadataAbortController) {
      try {
        metadataAbortController.abort();
      } catch (e) {}
      metadataAbortController = null;
    }
  }

  async function startIcyMetadataReader(station, streamUrl) {
    stopIcyMetadataReader();

    const isHls = station.isHls || streamUrl.includes('.m3u8');
    if (isHls) return; // Handled by HLS fragment metadata

    const controller = new AbortController();
    metadataAbortController = controller;
    const targetStationId = station.id;

    let targetUrl = streamUrl;
    if (window.location.protocol === 'https:' && targetUrl.startsWith('http://')) {
      targetUrl = targetUrl.replace(/^http:\/\//, 'https://');
    }

    async function streamIcy(url) {
      const res = await fetch(url, {
        headers: { 'Icy-MetaData': '1' },
        signal: controller.signal
      });
      if (!res.ok || !res.body) return false;

      let metaint = 0;
      for (const [key, val] of res.headers.entries()) {
        if (key.toLowerCase() === 'icy-metaint') {
          metaint = parseInt(val, 10);
          break;
        }
      }
      if (!metaint || isNaN(metaint)) return false;

      const reader = res.body.getReader();
      let buffer = new Uint8Array(0);

      function appendBuffer(chunk) {
        const next = new Uint8Array(buffer.length + chunk.length);
        next.set(buffer, 0);
        next.set(chunk, buffer.length);
        buffer = next;
      }

      while (!controller.signal.aborted && currentStation && currentStation.id === targetStationId) {
        while (buffer.length < metaint + 1 && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) return true;
          appendBuffer(value);
        }

        if (controller.signal.aborted || !currentStation || currentStation.id !== targetStationId) return true;

        const lenByte = buffer[metaint];
        const metaLength = lenByte * 16;
        const totalBlock = metaint + 1 + metaLength;

        while (buffer.length < totalBlock && !controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) return true;
          appendBuffer(value);
        }

        if (controller.signal.aborted || !currentStation || currentStation.id !== targetStationId) return true;

        if (metaLength > 0) {
          const metaBytes = buffer.slice(metaint + 1, totalBlock);
          const metaStr = new TextDecoder('utf-8').decode(metaBytes);
          const match = metaStr.match(/StreamTitle=['"]?(.*?)['"]?(?:;|$)/i);
          if (match && match[1]) {
            const cleaned = cleanStreamTitle(match[1]);
            if (cleaned) {
              onNewTrackInfo(cleaned, station);
            }
          }
        }

        buffer = buffer.slice(totalBlock);
      }
      return true;
    }

    try {
      await streamIcy(targetUrl);
    } catch (e) {
      if (!controller.signal.aborted && currentStation && currentStation.id === targetStationId) {
        if (station.fallbackUrl && station.fallbackUrl !== streamUrl) {
          try {
            let fbUrl = station.fallbackUrl;
            if (window.location.protocol === 'https:' && fbUrl.startsWith('http://')) {
              fbUrl = fbUrl.replace(/^http:\/\//, 'https://');
            }
            await streamIcy(fbUrl);
          } catch (_) {}
        }
      }
    } finally {
      // Release the slot so a later resume can start a fresh reader
      if (metadataAbortController === controller) {
        metadataAbortController = null;
      }
    }
  }

  /** Decode the text payload of an ID3 text frame */
  function decodeId3Text(bytes) {
    if (!bytes.length) return '';
    const enc = bytes[0];
    let body = bytes.subarray(1);
    let label = 'utf-8';
    if (enc === 0) label = 'iso-8859-1';
    else if (enc === 1) {
      if (body[0] === 0xFE && body[1] === 0xFF) { label = 'utf-16be'; body = body.subarray(2); }
      else if (body[0] === 0xFF && body[1] === 0xFE) { label = 'utf-16le'; body = body.subarray(2); }
      else label = 'utf-16le';
    } else if (enc === 2) label = 'utf-16be';
    return new TextDecoder(label).decode(body).replace(/\u0000+$/g, '').trim();
  }

  /** Pull "Artist - Title" out of an HLS timed-metadata sample (ID3v2), or return '' if there is none */
  function extractHlsTitle(data) {
    try {
      if (!data || data.length < 10) return '';
      const isId3 = data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33;
      if (!isId3) {
        const s = new TextDecoder('utf-8').decode(data);
        // eslint-disable-next-line no-control-regex
        return /[\u0000-\u0008\u000E-\u001F�]/.test(s.replace(/\u0000+$/g, '')) ? '' : s;
      }
      const ver = data[3];
      const tagSize = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
      const end = Math.min(data.length, 10 + tagSize);
      let pos = 10;
      let title = '';
      let artist = '';
      while (pos + 10 <= end) {
        const id = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
        if (!/^[A-Z0-9]{4}$/.test(id)) break;
        const size = ver === 4
          ? ((data[pos + 4] & 0x7f) << 21) | ((data[pos + 5] & 0x7f) << 14) | ((data[pos + 6] & 0x7f) << 7) | (data[pos + 7] & 0x7f)
          : ((data[pos + 4] << 24) | (data[pos + 5] << 16) | (data[pos + 6] << 8) | data[pos + 7]) >>> 0;
        if (size === 0) break;
        const payload = data.subarray(pos + 10, pos + 10 + size);
        if (id === 'TIT2') title = decodeId3Text(payload);
        else if (id === 'TPE1') artist = decodeId3Text(payload);
        pos += 10 + size;
      }
      if (!title) return '';
      return artist ? `${artist} - ${title}` : title;
    } catch (e) {
      return '';
    }
  }

  /** Start HTML5 / HLS Audio playback */
  function startAudio(station) {
    if (!station) return;
    stopIcyMetadataReader();
    clearTimeout(retryTimer);
    retryTimer = null;
    lastStartAt = Date.now();
    streamOffline = false;
    resetLyricsSyncForNewStream();

    if (hlsInstance) {
      try {
        hlsInstance.destroy();
      } catch (e) {}
      hlsInstance = null;
    }

    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch (e) {}

    setBuffering(true);
    updatePlaybackState(false);

    const streamUrl = (retryCount > 0 && station.fallbackUrl) ? station.fallbackUrl : station.streamUrl;
    currentStreamUrl = streamUrl;
    const isHls = station.isHls || streamUrl.includes('.m3u8');

    // HLS Support check
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3
      });
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(audio);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        audio.play().catch(handlePlayError);
      });
      hlsInstance.on(window.Hls.Events.FRAG_PARSING_METADATA, (event, data) => {
        if (data && data.samples) {
          for (const sample of data.samples) {
            if (sample.data) {
              try {
                const str = extractHlsTitle(sample.data);
                if (!str) continue;
                const cleaned = cleanStreamTitle(str);
                if (cleaned && cleaned !== currentTrackTitle && cleaned.toLowerCase() !== station.name.toLowerCase()) {
                  onNewTrackInfo(cleaned, station);
                }
              } catch (e) {}
            }
          }
        }
      });
      hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          handleFatalStreamError(station);
        }
      });
    } else {
      // Native audio or Safari native HLS
      audio.preload = 'auto';
      audio.src = streamUrl;
      audio.play().catch(handlePlayError);
      startIcyMetadataReader(station, streamUrl);
    }

    updateMediaSession(station);
  }

  /** Handle play promise error */
  function handlePlayError(err) {
    console.warn('Playback error or blocked by autoplay:', err);
    updatePlaybackState(false);
  }

  /** Handle fatal stream failure with fallback URL retry and clean backoff without auto-skipping */
  function handleFatalStreamError(station) {
    if (!station) return;

    // A retry is already scheduled (audio 'error' and HLS 'fatal' can both fire for one failure)
    if (retryTimer) return;

    if (retryCount === 0 && station.fallbackUrl && station.fallbackUrl !== station.streamUrl) {
      console.log('Retrying station with fallback URL...', station.name);
      retryCount++;
      if (playerTrack) playerTrack.textContent = `${station.name} (Retrying fallback...)`;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (currentStation && currentStation.id === station.id) {
          startAudio(station);
        }
      }, 1000);
      return;
    }

    if (retryCount < 2) {
      console.log(`Retrying station attempt ${retryCount + 1}...`, station.name);
      retryCount++;
      if (playerTrack) playerTrack.textContent = `${station.name} (Reconnecting...)`;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (currentStation && currentStation.id === station.id) {
          startAudio(station);
        }
      }, 1800);
      return;
    }

    console.warn('Stream unavailable after retries:', station.name);
    streamOffline = true;
    setBuffering(false);
    updatePlaybackState(false);
    if (playerTrack) playerTrack.textContent = `${station.name} (Stream Offline)`;
    showToast(`${station.name} is offline right now. Try the next station.`, 'warn');
  }

  /** Toggle Play / Pause */
  function togglePlayPause() {
    if (!currentStation) {
      if (filteredStations.length > 0) {
        playStation(filteredStations[0]);
      }
      return;
    }

    if (isPlaying) {
      audio.pause();
      updatePlaybackState(false);
    } else {
      // A live stream paused for a while would resume from stale buffered audio (or a dropped
      // connection). Reconnect to the live edge instead; short pauses just resume.
      const stale = pausedAt > 0 && (Date.now() - pausedAt) > LIVE_RESUME_STALE_MS;
      if ((!audio.src && !hlsInstance) || stale || streamOffline) {
        retryCount = 0;
        startAudio(currentStation);
      } else {
        audio.play().catch(handlePlayError);
        updatePlaybackState(true);
      }
    }
  }

  /** Play next station in current filter */
  function playNext(fromUser = true) {
    const now = Date.now();
    // Only user taps are debounced; programmatic skips (e.g. after blocking) must always go through
    if (fromUser && now - lastNavTimestamp < NAV_DEBOUNCE_MS) return;
    lastNavTimestamp = now;

    if (filteredStations.length === 0) return;

    if (isShuffle && filteredStations.length > 1) {
      if (shuffleDeck.length === 0) {
        refillShuffleDeck();
      }
      // The deck can contain the station we are on (e.g. after tapping a card directly): skip it
      let nextIdx = shuffleDeck.pop();
      if (nextIdx === currentIndex) {
        if (shuffleDeck.length === 0) refillShuffleDeck();
        nextIdx = shuffleDeck.pop();
      }
      playStation(filteredStations[nextIdx], true);
    } else {
      const nextIdx = (currentIndex + 1) % filteredStations.length;
      playStation(filteredStations[nextIdx], true);
    }
    scrollActiveCardIntoView();
  }

  function scrollActiveCardIntoView() {
    if (!stationsGrid) return;
    const el = stationsGrid.querySelector('.station-card.active-playing');
    if (el && el.scrollIntoView) {
      try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }
  }

  /** Play previous station in current filter (never shuffle on back!) */
  function playPrevious(fromUser = true) {
    const now = Date.now();
    if (fromUser && now - lastNavTimestamp < NAV_DEBOUNCE_MS) return;
    lastNavTimestamp = now;

    if (filteredStations.length === 0) return;

    if (playbackHistory.length > 0) {
      const prevId = playbackHistory.pop();
      const found = filteredStations.find(s => s.id === prevId);
      if (found && (!currentStation || found.id !== currentStation.id)) {
        playStation(found, false);
        return;
      }
    }

    const prevIdx = (currentIndex - 1 + filteredStations.length) % filteredStations.length;
    playStation(filteredStations[prevIdx], false);
    scrollActiveCardIntoView();
  }

  /** Toggle Favorite */
  function toggleFavorite(id) {
    if (favorites.has(id)) {
      favorites.delete(id);
    } else {
      favorites.add(id);
    }
    localStorage.setItem(LS_FAVS, JSON.stringify([...favorites]));
    updateBadges();

    if (currentMood === 'FAVORITES') {
      applyFilter();
    } else {
      renderStations();
    }

    if (currentStation && currentStation.id === id && favPlayerBtn) {
      const isFav = favorites.has(id);
      favPlayerBtn.classList.toggle('favorited', isFav);
      favPlayerBtn.innerHTML = heartSvg(isFav);
    }
    updateHero();
  }

  let miniManuallyClosed = false;
  let pipWindow = null;
  let pipVideoEl = null;
  let pipCanvasEl = null;
  let pipCanvasCtx = null;
  let pipCanvasInterval = null;
  const canonicalTitle = document.title;

  function updateTabTitle() {
    if (document.hidden) {
      if (isPlaying && currentStation) {
        const title = currentTrackTitle ? `${currentTrackTitle} - ${currentStation.name}` : currentStation.name;
        document.title = `▶ ${title} | AutoWave Radio`;
      } else {
        document.title = `⏸ AutoWave Radio Web`;
      }
    } else {
      document.title = canonicalTitle;
    }
  }

  function showMiniWidget() {
    if (window.innerWidth <= 768) return;
    document.body.classList.add('mini-player-active');
    if (cornerMiniWidget) {
      cornerMiniWidget.classList.remove('hidden');
    }
  }

  function hideMiniWidget() {
    document.body.classList.remove('mini-player-active');
    if (cornerMiniWidget) {
      cornerMiniWidget.classList.add('hidden');
    }
  }

  function toggleMiniWidget() {
    if (window.innerWidth <= 768) return;
    if (document.body.classList.contains('mini-player-active')) {
      miniManuallyClosed = true;
      hideMiniWidget();
    } else {
      miniManuallyClosed = false;
      showMiniWidget();
    }
  }

  function updateDocumentPipUI() {
    if (!pipWindow || pipWindow.closed) return;
    try {
      const art = currentStation ? (currentStation.favicon || 'icon-512.png') : 'icon-512.png';
      const title = currentStation ? currentStation.name : 'AutoWave Radio';
      const sub = currentStation ? `${currentStation.flag || '📻'} Live Stream` : 'Pure Driving Radio';

      const artEl = pipWindow.document.querySelector('.pip-art');
      const titleEl = pipWindow.document.querySelector('.pip-title');
      const subEl = pipWindow.document.querySelector('.pip-sub');
      const playEl = pipWindow.document.getElementById('pip-play');

      if (artEl) artEl.src = art;
      if (titleEl) titleEl.textContent = title;
      if (subEl) subEl.textContent = sub;
      if (playEl) playEl.textContent = isPlaying ? '⏸' : '▶';
    } catch (e) {}
  }

  function renderVideoPipFrame() {
    if (!pipCanvasCtx) return;
    const ctx = pipCanvasCtx;
    const w = 512, h = 512;

    ctx.fillStyle = '#070A10';
    ctx.fillRect(0, 0, w, h);

    const grad = ctx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, 250);
    grad.addColorStop(0, 'rgba(0, 255, 127, 0.15)');
    grad.addColorStop(1, 'rgba(7, 10, 16, 0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    const name = currentStation ? currentStation.name : 'AutoWave Radio';
    ctx.fillText(name, w / 2, 75);

    ctx.fillStyle = '#00FF7F';
    ctx.font = '600 17px -apple-system, BlinkMacSystemFont, sans-serif';
    const sub = currentStation ? `${currentStation.flag || '📻'} Live Broadcast` : 'Pure Driving Radio';
    ctx.fillText(sub, w / 2, 108);

    const artImg = playerArt;
    if (artImg && artImg.complete && artImg.naturalWidth > 0) {
      try {
        ctx.save();
        ctx.beginPath();
        const rx = 146, ry = 140, rw = 220, rh = 220, r = 24;
        if (ctx.roundRect) {
          ctx.roundRect(rx, ry, rw, rh, r);
        } else {
          ctx.rect(rx, ry, rw, rh);
        }
        ctx.clip();
        ctx.drawImage(artImg, rx, ry, rw, rh);
        ctx.restore();
      } catch (e) {}
    }

    if (isPlaying) {
      ctx.fillStyle = '#00FF7F';
      for (let i = 0; i < 5; i++) {
        const barH = 10 + Math.random() * 24;
        ctx.fillRect(w / 2 - 40 + i * 18, 430 - barH, 10, barH);
      }
    } else {
      ctx.fillStyle = '#9CA3AF';
      ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText('⏸ PAUSED', w / 2, 420);
    }
  }

  async function openVideoPiP() {
    if (!pipCanvasEl) {
      pipCanvasEl = document.createElement('canvas');
      pipCanvasEl.width = 512;
      pipCanvasEl.height = 512;
      pipCanvasCtx = pipCanvasEl.getContext('2d');
    }

    if (!pipVideoEl) {
      pipVideoEl = document.createElement('video');
      pipVideoEl.muted = true;
      pipVideoEl.playsInline = true;
      pipVideoEl.style.position = 'fixed';
      pipVideoEl.style.width = '1px';
      pipVideoEl.style.height = '1px';
      pipVideoEl.style.opacity = '0.01';
      pipVideoEl.style.pointerEvents = 'none';
      document.body.appendChild(pipVideoEl);

      pipVideoEl.addEventListener('leavepictureinpicture', () => {
        if (pipCanvasInterval) {
          clearInterval(pipCanvasInterval);
          pipCanvasInterval = null;
        }
        document.body.classList.remove('mini-player-active');
      });
    }

    renderVideoPipFrame();

    if (!pipVideoEl.srcObject) {
      const stream = pipCanvasEl.captureStream(10);
      pipVideoEl.srcObject = stream;
    }

    await pipVideoEl.play();
    await pipVideoEl.requestPictureInPicture();
    document.body.classList.add('mini-player-active');
    hideMiniWidget();

    if (!pipCanvasInterval) {
      pipCanvasInterval = setInterval(renderVideoPipFrame, 250);
    }
  }

  async function openDocumentPiP() {
    if (pipWindow) {
      pipWindow.close();
      pipWindow = null;
      document.body.classList.remove('mini-player-active');
      return;
    }

    pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 360,
      height: 150,
    });

    const style = pipWindow.document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      body { background: #070A10; color: #FFF; display: flex; align-items: center; justify-content: space-between; padding: 14px; height: 100vh; overflow: hidden; user-select: none; }
      .pip-card { display: flex; align-items: center; gap: 12px; width: 100%; }
      .pip-art { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: #121826; flex-shrink: 0; border: 1px solid rgba(0, 255, 127, 0.3); }
      .pip-info { flex: 1; min-width: 0; overflow: hidden; }
      .pip-title { font-size: 14px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #FFF; }
      .pip-sub { font-size: 12px; color: #00FF7F; font-weight: 600; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pip-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .pip-btn { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #FFF; border-radius: 50%; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; transition: all 0.2s; }
      .pip-btn:hover { background: rgba(255,255,255,0.2); }
      .pip-play { background: linear-gradient(135deg, #00FF7F 0%, #00B0FF 100%); color: #000; width: 40px; height: 40px; font-size: 16px; border: none; font-weight: bold; }
      .pip-play:hover { transform: scale(1.05); }
    `;
    pipWindow.document.head.appendChild(style);

    const art = currentStation ? (currentStation.favicon || 'icon-512.png') : 'icon-512.png';
    const title = currentStation ? currentStation.name : 'AutoWave Radio';
    const sub = currentStation ? `${currentStation.flag || '📻'} Live Stream` : 'Pure Driving Radio';

    pipWindow.document.body.innerHTML = `
      <div class="pip-card">
        <img class="pip-art" src="${escapeHtml(art)}" alt="Artwork" />
        <div class="pip-info">
          <div class="pip-title">${escapeHtml(title)}</div>
          <div class="pip-sub">${escapeHtml(sub)}</div>
        </div>
        <div class="pip-controls">
          <button id="pip-prev" class="pip-btn" title="Previous">⏮</button>
          <button id="pip-play" class="pip-btn pip-play" title="Play/Pause">${isPlaying ? '⏸' : '▶'}</button>
          <button id="pip-next" class="pip-btn" title="Next">⏭</button>
        </div>
      </div>
    `;

    pipWindow.document.getElementById('pip-prev')?.addEventListener('click', () => { playPrevious(); });
    pipWindow.document.getElementById('pip-play')?.addEventListener('click', () => { togglePlayPause(); });
    pipWindow.document.getElementById('pip-next')?.addEventListener('click', () => { playNext(); });

    pipWindow.addEventListener('pagehide', () => {
      pipWindow = null;
      document.body.classList.remove('mini-player-active');
    });

    document.body.classList.add('mini-player-active');
    hideMiniWidget();
  }

  async function togglePopoutMiniPlayer() {
    // 1. If Document PiP is open, close it
    if (pipWindow && !pipWindow.closed) {
      pipWindow.close();
      pipWindow = null;
      document.body.classList.remove('mini-player-active');
      return;
    }

    // 2. If Video PiP is open, exit it
    if (document.pictureInPictureElement) {
      try {
        await document.exitPictureInPicture();
      } catch (e) {}
      document.body.classList.remove('mini-player-active');
      return;
    }

    // 3. Try Document Picture-in-Picture first (Chrome/Edge desktop - rich HTML)
    if ('documentPictureInPicture' in window) {
      try {
        await openDocumentPiP();
        return;
      } catch (err) {
        console.warn('Document PiP request failed:', err);
      }
    }

    // 4. Try Video Picture-in-Picture fallback (Safari, Firefox, Android Chrome)
    try {
      await openVideoPiP();
      return;
    } catch (err) {
      console.warn('Video PiP request failed:', err);
    }

    // 5. Ultimate fallback if browser denies all PiP permissions
    toggleMiniWidget();
  }

  /** Update playback button and equalizer UI */
  function updatePlaybackState(playing) {
    if (!playing && isPlaying) pausedAt = Date.now();
    if (playing) pausedAt = 0;
    isPlaying = playing;
    document.body.classList.toggle('is-playing', playing);
    if (playing) {
      cancelIdleShutdownWatchdog();
    } else {
      startIdleShutdownWatchdog();
    }
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) {}
    }

    if (playIcon) playIcon.style.display = playing ? 'none' : 'inline-block';
    if (pauseIcon) pauseIcon.style.display = playing ? 'inline-block' : 'none';

    if (dmPlayIcon) dmPlayIcon.style.display = playing ? 'none' : 'inline-block';
    if (dmPauseIcon) dmPauseIcon.style.display = playing ? 'inline-block' : 'none';

    if (miniPlayIcon) miniPlayIcon.style.display = playing ? 'none' : 'inline-block';
    if (miniPauseIcon) miniPauseIcon.style.display = playing ? 'inline-block' : 'none';

    if (equalizer) {
      equalizer.style.opacity = playing ? '1' : '0.2';
    }

    updateDocumentPipUI();
    renderVideoPipFrame();
    updateTabTitle();
    updateActiveStationCard();
    updateHero();
  }

  /** Setup MediaSession API (Steering wheel & keyboard multimedia keys) */
  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrevious(true));
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(true));
      try {
        navigator.mediaSession.setActionHandler('stop', () => {
          if (isPlaying) togglePlayPause();
        });
      } catch (e) { /* 'stop' is not supported everywhere */ }
    }
  }

  function updateMediaSession(station, track = '') {
    if ('mediaSession' in navigator && station) {
      const displayTitle = track || station.name;
      const displayArtist = track ? `${station.name} • AutoWave Radio` : `AutoWave Radio • ${station.country || 'Live Radio'}`;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: displayTitle,
        artist: displayArtist,
        album: station.name,
        artwork: [
          { src: station.favicon || 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    }
  }

  /** Setup Event Listeners */
  function setupEventListeners() {
    // Audio events
    audio.addEventListener('playing', () => {
      consecutiveAutoSkips = 0;
      retryCount = 0;
      streamOffline = false;
      setBuffering(false);
      updatePlaybackState(true);
      // Resuming from a pause: the metadata reader was stopped to save bandwidth, restart it
      if (currentStation && !metadataAbortController && currentStreamUrl) {
        if (syncEngine) syncEngine.markNextTrackUncertain();
        startIcyMetadataReader(currentStation, currentStreamUrl);
      }
    });
    audio.addEventListener('pause', () => {
      setBuffering(false);
      // Ignore the pause() that startAudio() itself issues while switching streams
      if (Date.now() - lastStartAt > 1000) stopIcyMetadataReader();
      updatePlaybackState(false);
    });
    audio.addEventListener('waiting', () => { if (!audio.paused) setBuffering(true); });
    audio.addEventListener('canplay', () => { if (!audio.paused) setBuffering(false); });
    audio.addEventListener('error', () => {
      // Clearing the src while switching stations can raise a spurious error: ignore it
      if (!audio.getAttribute('src') && !hlsInstance) return;
      if (currentStation) handleFatalStreamError(currentStation);
    });
    // A live stream never legitimately ends: reconnect if the connection dropped
    audio.addEventListener('ended', () => {
      if (currentStation && isPlaying) {
        retryCount = 0;
        handleFatalStreamError(currentStation);
      }
    });
    // Network came back while we were offline/stalled
    window.addEventListener('online', () => {
      if (currentStation && (streamOffline || (isPlaying && audio.paused))) {
        retryCount = 0;
        startAudio(currentStation);
      }
    });

    // Player bar controls
    if (shuffleBtn) shuffleBtn.addEventListener('click', toggleShuffle);
    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayPause);
    if (prevBtn) prevBtn.addEventListener('click', () => playPrevious(true));
    if (nextBtn) nextBtn.addEventListener('click', () => playNext(true));

    if (favPlayerBtn) {
      favPlayerBtn.addEventListener('click', () => {
        if (currentStation) toggleFavorite(currentStation.id);
      });
    }

    const playerBlockBtn = document.getElementById('btn-player-block');
    if (playerBlockBtn) {
      playerBlockBtn.addEventListener('click', () => {
        if (currentStation) blockStation(currentStation.id);
      });
    }

    // Volume Slider
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (!Number.isFinite(val)) return;
        audio.volume = val;
        if (audio.muted && val > 0) audio.muted = false;
        updateVolumeTrack(val);
        updateMuteUI();
        localStorage.setItem(LS_VOLUME, val);
      });
    }

    // Mute button
    function updateMuteUI() {
      if (!btnMute) return;
      const muted = audio.muted || audio.volume === 0;
      btnMute.innerHTML = iconSvg(muted ? 'i-mute' : 'i-volume');
      btnMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }
    if (btnMute) {
      btnMute.addEventListener('click', () => {
        if (audio.volume === 0) {
          audio.volume = 0.5;
          if (volumeSlider) volumeSlider.value = 0.5;
          updateVolumeTrack(0.5);
        }
        audio.muted = !audio.muted;
        updateMuteUI();
      });
      updateMuteUI();
    }
    window.toggleMuteShortcut = () => { if (btnMute) btnMute.click(); };

    // Hero buttons
    if (heroPlayBtn) heroPlayBtn.addEventListener('click', togglePlayPause);
    if (heroLyricsBtn) heroLyricsBtn.addEventListener('click', () => openLyricsModal());
    if (heroFavBtn) {
      heroFavBtn.addEventListener('click', () => {
        if (currentStation) toggleFavorite(currentStation.id);
        else showToast('Pick a station first.');
      });
    }

    // Station grid: one delegated handler (click + keyboard activation)
    if (stationsGrid) {
      stationsGrid.addEventListener('click', handleGridActivate);
      stationsGrid.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('station-card')) {
          e.preventDefault();
          handleGridActivate(e);
        }
      });
    }

    // Search input
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        applyFilter();
      });
    }

    if (btnUnblockAll) {
      btnUnblockAll.addEventListener('click', unblockAll);
    }

    // Nav Items (Desktop Sidebar Moods)
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        const mood = item.getAttribute('data-mood') || 'ALL';
        currentMood = mood;
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Sync mobile mood pills
        document.querySelectorAll('.mood-pill').forEach(p => {
          p.classList.toggle('active', p.getAttribute('data-mood') === mood);
        });

        applyFilter();
      });
    });

    // Mobile Mood Pills
    const mobileMoodPills = document.querySelectorAll('.mood-pill');
    mobileMoodPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const mood = pill.getAttribute('data-mood') || 'ALL';
        currentMood = mood;
        mobileMoodPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');

        // Sync desktop sidebar nav items
        navItems.forEach(n => {
          n.classList.toggle('active', n.getAttribute('data-mood') === mood);
        });

        applyFilter();
      });
    });

    // Mobile Header Actions
    const btnInfoMobile = document.getElementById('btn-info-mobile');
    if (btnInfoMobile) {
      btnInfoMobile.addEventListener('click', () => {
        if (infoModal) infoModal.classList.add('active');
      });
    }

    const btnDrivingMobile = document.getElementById('btn-driving-mobile');
    if (btnDrivingMobile) {
      btnDrivingMobile.addEventListener('click', () => {
        if (drivingModeOverlay) drivingModeOverlay.classList.add('active');
      });
    }

    // Driving Mode Open / Close
    if (btnDrivingMode) {
      btnDrivingMode.addEventListener('click', () => {
        if (drivingModeOverlay) drivingModeOverlay.classList.add('active');
      });
    }

    if (btnExitDm) {
      btnExitDm.addEventListener('click', () => {
        if (drivingModeOverlay) drivingModeOverlay.classList.remove('active');
      });
    }

    // Driving Mode Controls
    if (dmShuffleBtn) dmShuffleBtn.addEventListener('click', toggleShuffle);
    if (dmPlayPauseBtn) dmPlayPauseBtn.addEventListener('click', togglePlayPause);
    if (dmPrevBtn) dmPrevBtn.addEventListener('click', () => playPrevious(true));
    if (dmNextBtn) dmNextBtn.addEventListener('click', () => playNext(true));

    // Corner Mini Widget controls
    if (btnMiniClose) {
      btnMiniClose.addEventListener('click', (e) => {
        e.stopPropagation();
        miniManuallyClosed = true;
        hideMiniWidget();
      });
    }
    if (miniShuffleBtn) miniShuffleBtn.addEventListener('click', toggleShuffle);
    if (btnMiniPlay) btnMiniPlay.addEventListener('click', togglePlayPause);
    if (btnMiniPrev) btnMiniPrev.addEventListener('click', () => playPrevious(true));
    if (btnMiniNext) btnMiniNext.addEventListener('click', () => playNext(true));
    if (btnMiniPip) btnMiniPip.addEventListener('click', togglePopoutMiniPlayer);
    if (btnToggleMini) btnToggleMini.addEventListener('click', togglePopoutMiniPlayer);

    const pipRestoreBar = document.getElementById('pip-restore-bar');
    if (pipRestoreBar) {
      pipRestoreBar.addEventListener('click', togglePopoutMiniPlayer);
    }

    // Clicking mini widget card (outside control buttons) restores full player bar
    if (cornerMiniWidget) {
      cornerMiniWidget.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
          hideMiniWidget();
        }
      });
    }

    // Dynamic Tab title on visibility change
    document.addEventListener('visibilitychange', () => {
      updateTabTitle();
    });

    // Auto-restore on resize to mobile
    window.addEventListener('resize', () => {
      if (window.innerWidth <= 768 && document.body.classList.contains('mini-player-active')) {
        hideMiniWidget();
      }
    });

    // Information & Legal Modal controls
    if (navInfoBtn) {
      navInfoBtn.addEventListener('click', () => {
        if (infoModal) infoModal.classList.add('active');
      });
    }
    if (btnInfoClose) {
      btnInfoClose.addEventListener('click', () => {
        if (infoModal) infoModal.classList.remove('active');
      });
    }
    if (infoModal) {
      infoModal.addEventListener('click', (e) => {
        if (e.target === infoModal) {
          infoModal.classList.remove('active');
        }
      });
    }

    // Keyboard navigation (Space: Play/Pause, ArrowLeft: Prev, ArrowRight: Next, S: Shuffle, Escape: Close modal/cockpit)
    window.addEventListener('keydown', (e) => {
      // Never hijack browser shortcuts (Ctrl/Cmd+S, Alt+Left for back, ...)
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;

      if (e.code === 'Escape') {
        if (drivingModeOverlay && drivingModeOverlay.classList.contains('active')) {
          drivingModeOverlay.classList.remove('active');
        }
        if (infoModal && infoModal.classList.contains('active')) {
          infoModal.classList.remove('active');
        }
        return;
      }

      // Space/Enter on a focused button or link must keep its normal action
      // (otherwise Space would both click the button and toggle playback = no-op)
      const onActivatable = tag === 'BUTTON' || tag === 'A' || (e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button');

      if (e.code === 'Space') {
        if (onActivatable) return;
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'KeyS') {
        e.preventDefault();
        toggleShuffle();
      } else if (e.code === 'KeyM') {
        e.preventDefault();
        if (window.toggleMuteShortcut) window.toggleMuteShortcut();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext(true);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrevious(true);
      }
    });

    // Keyboard access for the mood navigation (sidebar items and mobile pills)
    document.querySelectorAll('.nav-item, .mood-pill').forEach(el => {
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          el.click();
        }
      });
    });

    initLyricsElements();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
