/**
 * AutoWave Radio Web Player
 * High-performance, zero-dependency streaming radio engine with HLS fallback,
 * MediaSession steering-wheel integration, and driving mode.
 */

(function () {
  'use strict';

  // State
  const stations = window.AUTOWAVE_STATIONS || [];
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

  // Load blocked stations
  let blockedStations = new Set();
  try {
    const rawBlocked = localStorage.getItem(LS_BLOCKED) || '[]';
    blockedStations = new Set(JSON.parse(rawBlocked));
  } catch (e) {
    blockedStations = new Set();
  }

  // Audio element
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = parseFloat(localStorage.getItem(LS_VOLUME) || localStorage.getItem('drivewave_web_volume') || '0.85');

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
    ALL: { title: '🔥 All Stations', subtitle: 'Curated high-bitrate live radio broadcasts from around the world.' },
    POP_HITS: { title: '⭐ Top Rated', subtitle: 'World-famous pop hit music stations and chart-toppers.' },
    LATIN_SPANISH: { title: '💃 Latin & Spanish', subtitle: 'Reggaeton, Bachata, Salsa, and Latin pop hits.' },
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

    // Restore last station if saved
    const lastId = localStorage.getItem(LS_LAST_STATION) || localStorage.getItem('drivewave_web_last_station');
    if (lastId) {
      const found = stations.find(s => s.id === lastId);
      if (found) {
        setStationUI(found, false);
      }
    } else if (stations.length > 0) {
      setStationUI(stations[0], false);
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
      const rawGenre = tagList[0] ? tagList[0].trim() : (st.country || 'Live');
      const genre = rawGenre ? (rawGenre.charAt(0).toUpperCase() + rawGenre.slice(1)) : 'Live';

      const monogram = getStationMonogram(st.name);
      const bgGrad = getStationGradient(st.name);
      const subLabel = st.flag || st.countryCode || 'LIVE';
      const monoFontSize = monogram.length > 5 ? '11px' : (monogram.length > 3 ? '12.5px' : '14px');

      const artHtml = `
        <div class="card-art-badge" style="background: ${bgGrad}">
          <span class="card-badge-monogram" style="font-size: ${monoFontSize};">${monogram}</span>
          <span class="card-badge-country">${subLabel}</span>
        </div>
      `;

      const isBlockedMood = (currentMood === 'BLOCKED');
      const actionHtml = isBlockedMood ? `
        <div class="card-actions-group">
          <button class="card-unblock-btn" title="Unblock Station" data-unblockid="${st.id}">
            <span>✓</span> Unblock
          </button>
        </div>
      ` : `
        <div class="card-actions-group">
          <button class="card-fav-btn ${favClass}" title="Favorite" data-favid="${st.id}">
            ${isFav ? '❤️' : '♡'}
          </button>
          <button class="card-block-btn" title="Block Station" data-blockid="${st.id}">
            🚫
          </button>
        </div>
      `;

      return `
        <div class="station-card ${activeClass}" data-id="${st.id}" data-idx="${idx}">
          <div class="card-art-box">
            ${artHtml}
          </div>
          <div class="card-details">
            <div class="card-title">${st.name}</div>
            <div class="card-meta">
              <span>${flag}</span>
              <span>•</span>
              <span>${genre}</span>
            </div>
          </div>
          ${actionHtml}
        </div>
      `;
    }).join('');

    // Attach click listeners to cards
    stationsGrid.querySelectorAll('.station-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.card-unblock-btn')) {
          e.stopPropagation();
          const id = e.target.closest('.card-unblock-btn').getAttribute('data-unblockid');
          if (id) unblockStation(id);
          return;
        }
        if (e.target.closest('.card-block-btn')) {
          e.stopPropagation();
          const id = e.target.closest('.card-block-btn').getAttribute('data-blockid');
          if (id) blockStation(id);
          return;
        }
        if (e.target.closest('.card-fav-btn')) {
          e.stopPropagation();
          const id = e.target.closest('.card-fav-btn').getAttribute('data-favid');
          toggleFavorite(id);
          return;
        }
        const id = card.getAttribute('data-id');
        const st = stations.find(s => s.id === id);
        if (st) {
          if (currentStation && currentStation.id === st.id) {
            togglePlayPause();
          } else {
            playStation(st);
          }
        }
      });
    });
  }

  function blockStation(id) {
    if (!id) return;
    blockedStations.add(id);
    localStorage.setItem(LS_BLOCKED, JSON.stringify([...blockedStations]));
    updateBadges();
    if (currentStation && currentStation.id === id) {
      playNext(false);
    }
    applyFilter();
  }

  function unblockStation(id) {
    if (!id) return;
    blockedStations.delete(id);
    localStorage.setItem(LS_BLOCKED, JSON.stringify([...blockedStations]));
    updateBadges();
    applyFilter();
  }

  function unblockAll() {
    if (blockedStations.size === 0) return;
    blockedStations.clear();
    localStorage.setItem(LS_BLOCKED, JSON.stringify([]));
    updateBadges();
    applyFilter();
  }

  function updateActiveStationCard() {
    if (!stationsGrid) return;
    const prevActive = stationsGrid.querySelectorAll('.station-card.active-playing');
    prevActive.forEach(el => el.classList.remove('active-playing'));
    if (currentStation) {
      const currentEl = stationsGrid.querySelector(`.station-card[data-id="${currentStation.id}"]`);
      if (currentEl) {
        currentEl.classList.add('active-playing');
      }
    }
  }

  /** Set Station in UI without necessarily playing */
  function setStationUI(station, shouldPlay = false) {
    currentStation = station;
    currentIndex = filteredStations.findIndex(s => s.id === station.id);

    const artUrl = station.favicon || 'icon-512.png';
    if (playerArt) playerArt.src = artUrl;
    if (dmArtwork) dmArtwork.src = artUrl;
    if (miniArt) miniArt.src = artUrl;

    if (playerTrack) playerTrack.textContent = station.name;
    if (dmTrackTitle) dmTrackTitle.textContent = station.name;
    if (miniTitle) miniTitle.textContent = station.name;

    const subtitleText = `${station.flag || '📻'} ${station.country || 'Live'} • Live Stream`;
    if (playerStation) {
      playerStation.innerHTML = `<span>📻</span> <span>${subtitleText}</span>`;
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
      favPlayerBtn.textContent = isFav ? '❤️' : '♡';
    }

    localStorage.setItem(LS_LAST_STATION, station.id);

    updateDocumentPipUI();
    renderVideoPipFrame();
    updateActiveStationCard();

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
    let title = raw.trim().replace(/^['"\s`]+|['"\s`]+$/g, '');

    // Loop to strip nested wrappers like StreamTitle=, TEXT=, TITLE=, etc.
    let changed = true;
    let loops = 0;
    while (changed && loops < 5) {
      loops++;
      const prev = title;
      title = title.replace(/^StreamTitle\s*[:=]\s*['"]?(.*?)['"]?(?:;.*)?$/i, '$1').trim();
      title = title.replace(/^TEXT\s*[:=]\s*['"]?(.*?)['"]?(?:;.*)?$/i, '$1').trim();
      title = title.replace(/^TITLE\s*[:=]\s*['"]?(.*?)['"]?(?:;.*)?$/i, '$1').trim();
      title = title.replace(/^(?:SONG|TRACK)\s*[:=]\s*['"]?(.*?)['"]?(?:;.*)?$/i, '$1').trim();
      title = title.replace(/^['"\s`;]+|['"\s`;]+$/g, '');
      changed = (title !== prev);
    }

    // Handle artist=...;title=...
    const atMatch = title.match(/^artist=['"]?(.*?)['"]?[;,]\s*title=['"]?(.*?)['"]?$/i);
    if (atMatch) {
      const a = atMatch[1].trim().replace(/^['"]+|['"]+$/g, '');
      const t = atMatch[2].trim().replace(/^['"]+|['"]+$/g, '');
      title = (a && t) ? `${a} - ${t}` : (t || a);
    }

    // Strip TITLE=... prefix
    title = title.replace(/^title[:=]\s*['"]?(.*?)['"]?$/i, '$1').trim();

    // Strip trailing key=value pairs after semicolon
    const semiIdx = title.indexOf(';');
    if (semiIdx > 0) {
      const after = title.substring(semiIdx + 1);
      if (/^\s*[a-zA-Z0-9_-]+=/i.test(after)) {
        title = title.substring(0, semiIdx).trim();
      }
    }

    // Strip known ICY keys
    ['song_spot=', 'MediaBaseId=', 'itunesTrackId=', 'amgTrackId=', 'amgArtistId=', 'StreamUrl=', 'text='].forEach(k => {
      const idx = title.toLowerCase().indexOf(k.toLowerCase());
      if (idx > 0) title = title.substring(0, idx).trim();
    });

    title = title.replace(/^(?:NOW PLAYING|NOW ON AIR|LIVE|NP):\s*/i, '');
    title = title.replace(/^\s*(?:text|title|song|track)\s*[:=]\s*/i, '');
    return title.trim().replace(/^['"`\s-]+|['"`\s-;]+$/g, '');
  }

  function onNewTrackInfo(track, station) {
    if (!track) return;

    if (track === currentTrackTitle) return;
    currentTrackTitle = track;

    // Update Player Bar
    if (playerTrack) {
      playerTrack.textContent = track;
      playerTrack.title = track;
    }
    if (playerStation && station) {
      playerStation.innerHTML = `<span>📻</span> <span>${station.name} • Live</span>`;
    }

    // Update Cockpit Driving Mode
    if (dmTrackTitle) dmTrackTitle.textContent = track;
    if (dmStationName && station) dmStationName.textContent = station.name;

    // Update Mini Player
    if (miniTitle) miniTitle.textContent = track;
    if (miniSub && station) miniSub.textContent = station.name;

    // Update MediaSession
    updateMediaSession(station, track);

    // Update PiP and Tab Title
    updateDocumentPipUI();
    renderVideoPipFrame();
  }

  /** Start HTML5 / HLS Audio playback */
  function startAudio(station) {
    if (!station) return;

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

    isBuffering = true;
    updatePlaybackState(false);

    const streamUrl = (retryCount > 0 && station.fallbackUrl) ? station.fallbackUrl : station.streamUrl;
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
                const str = new TextDecoder('utf-8').decode(sample.data);
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

    if (retryCount === 0 && station.fallbackUrl && station.fallbackUrl !== station.streamUrl) {
      console.log('Retrying station with fallback URL...', station.name);
      retryCount++;
      if (playerTrack) playerTrack.textContent = `${station.name} (Retrying fallback...)`;
      setTimeout(() => {
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
      setTimeout(() => {
        if (currentStation && currentStation.id === station.id) {
          startAudio(station);
        }
      }, 1800);
      return;
    }

    console.warn('Stream unavailable after retries:', station.name);
    updatePlaybackState(false);
    if (playerTrack) playerTrack.textContent = `${station.name} (Stream Offline)`;
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
      if (!audio.src && !hlsInstance) {
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
    if (now - lastNavTimestamp < NAV_DEBOUNCE_MS) return;
    lastNavTimestamp = now;

    if (filteredStations.length === 0) return;

    if (isShuffle && filteredStations.length > 1) {
      if (shuffleDeck.length === 0) {
        refillShuffleDeck();
      }
      const nextIdx = shuffleDeck.pop();
      playStation(filteredStations[nextIdx], true);
    } else {
      const nextIdx = (currentIndex + 1) % filteredStations.length;
      playStation(filteredStations[nextIdx], true);
    }
  }

  /** Play previous station in current filter (never shuffle on back!) */
  function playPrevious(fromUser = true) {
    const now = Date.now();
    if (now - lastNavTimestamp < NAV_DEBOUNCE_MS) return;
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
      favPlayerBtn.textContent = isFav ? '❤️' : '♡';
    }
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
        <img class="pip-art" src="${art}" alt="Artwork" />
        <div class="pip-info">
          <div class="pip-title">${title}</div>
          <div class="pip-sub">${sub}</div>
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
    isPlaying = playing;
    if (playing) {
      cancelIdleShutdownWatchdog();
    } else {
      startIdleShutdownWatchdog();
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
  }

  /** Setup MediaSession API (Steering wheel & keyboard multimedia keys) */
  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrevious(true));
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext(true));
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
      isBuffering = false;
      consecutiveAutoSkips = 0;
      retryCount = 0;
      updatePlaybackState(true);
    });
    audio.addEventListener('pause', () => updatePlaybackState(false));
    audio.addEventListener('waiting', () => { isBuffering = true; });
    audio.addEventListener('error', () => {
      if (currentStation) handleFatalStreamError(currentStation);
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

    // Volume Slider
    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        audio.volume = val;
        updateVolumeTrack(val);
        localStorage.setItem(LS_VOLUME, val);
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
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'KeyS' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        toggleShuffle();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext(true);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrevious(true);
      } else if (e.code === 'Escape') {
        if (drivingModeOverlay && drivingModeOverlay.classList.contains('active')) {
          drivingModeOverlay.classList.remove('active');
        }
        if (infoModal && infoModal.classList.contains('active')) {
          infoModal.classList.remove('active');
        }
      }
    });
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
