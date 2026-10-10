/**
 * DriveWave Web Player
 * High-performance, zero-dependency streaming radio engine with HLS fallback,
 * MediaSession steering-wheel integration, and driving mode.
 */

(function () {
  'use strict';

  // State
  const stations = window.DRIVEWAVE_STATIONS || [];
  let filteredStations = [...stations];
  let currentStation = null;
  let currentIndex = -1;
  let isPlaying = false;
  let isBuffering = false;
  let currentMood = 'ALL';
  let currentCountry = 'ALL';
  let searchQuery = '';
  let hlsInstance = null;
  let retryCount = 0;

  // LocalStorage keys
  const LS_FAVS = 'drivewave_web_favorites';
  const LS_VOLUME = 'drivewave_web_volume';
  const LS_LAST_STATION = 'drivewave_web_last_station';

  // Load favorites
  let favorites = new Set();
  try {
    const savedFavs = JSON.parse(localStorage.getItem(LS_FAVS) || '[]');
    favorites = new Set(savedFavs);
  } catch (e) {
    favorites = new Set();
  }

  // Audio element
  const audio = new Audio();
  audio.preload = 'none';
  audio.volume = parseFloat(localStorage.getItem(LS_VOLUME) || '0.85');

  // DOM Elements
  const stationsGrid = document.getElementById('stations-grid');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const shelfTitle = document.getElementById('shelf-title');
  const shelfSubtitle = document.getElementById('shelf-subtitle');
  const countryFilters = document.getElementById('country-filters');
  const navItems = document.querySelectorAll('.nav-item');

  // Player DOM Elements
  const playerArt = document.getElementById('player-art');
  const playerTrack = document.getElementById('player-track');
  const playerStation = document.getElementById('player-station');
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
  const dmPlayPauseBtn = document.getElementById('dm-btn-play');
  const dmPlayIcon = document.getElementById('dm-play-icon');
  const dmPauseIcon = document.getElementById('dm-pause-icon');
  const dmPrevBtn = document.getElementById('dm-btn-prev');
  const dmNextBtn = document.getElementById('dm-btn-next');

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
    ALL: { title: '🔥 All Stations', subtitle: '182 hand-picked live radio broadcasts from the UK, US, Spain & worldwide.' },
    POP_HITS: { title: '⭐ Pop Hits', subtitle: 'The biggest chart-topping number 1 hits and Top 40 favorites.' },
    LATIN_SPANISH: { title: '💃 Latin & Spanish', subtitle: 'Reggaeton, Bachata, Salsa, and Spanish pop from Madrid, Miami, Mexico & Latin America.' },
    LONG_DRIVE: { title: '🛣️ Long Drive', subtitle: 'Highway cruising rhythms, road trip classics, and steady tempo hits.' },
    FUN_ENERGY: { title: '⚡ Fun & Energy', subtitle: 'Dance hits, electronic energy, and party anthems to keep your drive energized.' },
    CALM_CHILL: { title: '☕ Calm & Chill', subtitle: 'Relaxed acoustics, soft vocals, and ambient companions for night cruising.' },
    ROCK: { title: '🎸 Rock Anthems', subtitle: 'Classic guitar riffs, 90s alt-rock anthems, and stadium rock.' },
    NEWS_COMMUTE: { title: '📰 News & Commute', subtitle: '24/7 world journalism, traffic, and talk in crystal-clear broadcasts.' },
    FAVORITES: { title: '⭐ Favorites', subtitle: 'Your saved road-trip radio stations.' }
  };

  /** Initialize App */
  function init() {
    updateBadges();
    applyFilter();
    setupEventListeners();
    setupMediaSession();

    // Restore last station if saved
    const lastId = localStorage.getItem(LS_LAST_STATION);
    if (lastId) {
      const found = stations.find(s => s.id === lastId);
      if (found) {
        setStationUI(found, false);
      }
    } else if (stations.length > 0) {
      setStationUI(stations[0], false);
    }
  }

  /** Update sidebar counts */
  function updateBadges() {
    document.querySelectorAll('[data-mood]').forEach(el => {
      const mood = el.getAttribute('data-mood');
      const badge = el.querySelector('.nav-badge');
      if (!badge) return;
      if (mood === 'ALL') {
        badge.textContent = stations.length;
      } else if (mood === 'FAVORITES') {
        badge.textContent = favorites.size;
      } else {
        const count = stations.filter(s => s.moods && s.moods.includes(mood)).length;
        badge.textContent = count;
      }
    });
  }

  /** Filter stations based on mood, country, and search query */
  function applyFilter() {
    filteredStations = stations.filter(s => {
      // Mood match
      if (currentMood === 'FAVORITES') {
        if (!favorites.has(s.id)) return false;
      } else if (currentMood !== 'ALL') {
        if (!s.moods || !s.moods.includes(currentMood)) return false;
      }

      // Country match
      if (currentCountry !== 'ALL') {
        if (s.countryCode !== currentCountry) return false;
      }

      // Search match
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const combined = `${s.name} ${s.country} ${(s.tags || []).join(' ')}`.toLowerCase();
        if (!combined.includes(q)) return false;
      }

      return true;
    });

    // Update shelf title
    const meta = MOOD_META[currentMood] || MOOD_META.ALL;
    if (shelfTitle) shelfTitle.innerHTML = meta.title + ` <span style="font-size: 16px; color: var(--accent); font-weight: 600;">(${filteredStations.length})</span>`;
    if (shelfSubtitle) shelfSubtitle.textContent = meta.subtitle;

    renderStations();
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
      const genre = (st.tags && st.tags[0]) ? st.tags[0] : (st.country || 'Live');

      const artHtml = st.favicon
        ? `<img class="card-art-img" src="${st.favicon}" alt="${st.name}" onerror="this.onerror=null; this.src='icon-512.png';">`
        : `<span class="card-art-fallback">${st.flag || '📻'}</span>`;

      return `
        <div class="station-card ${activeClass}" data-id="${st.id}" data-idx="${idx}">
          <div class="card-art-box">
            ${artHtml}
            <div class="card-play-overlay">
              <span>${isCurr && isPlaying ? '⏸' : '▶'}</span>
            </div>
          </div>
          <div class="card-details">
            <div class="card-title">${st.name}</div>
            <div class="card-meta">
              <span>${st.flag}</span>
              <span>•</span>
              <span>${genre}</span>
            </div>
          </div>
          <button class="card-fav-btn ${favClass}" title="Favorite" data-favid="${st.id}">
            ★
          </button>
        </div>
      `;
    }).join('');

    // Attach click listeners to cards
    stationsGrid.querySelectorAll('.station-card').forEach(card => {
      card.addEventListener('click', (e) => {
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

  /** Set Station in UI without necessarily playing */
  function setStationUI(station, shouldPlay = false) {
    currentStation = station;
    currentIndex = filteredStations.findIndex(s => s.id === station.id);

    const artUrl = station.favicon || 'icon-512.png';
    if (playerArt) playerArt.src = artUrl;
    if (dmArtwork) dmArtwork.src = artUrl;

    if (playerTrack) playerTrack.textContent = station.name;
    if (dmTrackTitle) dmTrackTitle.textContent = station.name;

    const subtitleText = `${station.flag} ${station.country || 'Live'} • Live Stream`;
    if (playerStation) {
      playerStation.innerHTML = `<span>📻</span> <span>${subtitleText}</span>`;
    }
    if (dmStationName) {
      dmStationName.textContent = subtitleText;
    }

    if (favPlayerBtn) {
      favPlayerBtn.classList.toggle('favorited', favorites.has(station.id));
    }

    localStorage.setItem(LS_LAST_STATION, station.id);

    if (shouldPlay) {
      startAudio(station);
    }
  }

  /** Play a station */
  function playStation(station) {
    retryCount = 0;
    setStationUI(station, true);
    renderStations();
  }

  /** Start HTML5 / HLS Audio playback */
  function startAudio(station) {
    if (!station) return;

    if (hlsInstance) {
      hlsInstance.destroy();
      hlsInstance = null;
    }

    isBuffering = true;
    updatePlaybackState(false);

    const streamUrl = (retryCount > 0 && station.fallbackUrl) ? station.fallbackUrl : station.streamUrl;
    const isHls = station.isHls || streamUrl.includes('.m3u8');

    // HLS Support check
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30
      });
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(audio);
      hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
        audio.play().catch(handlePlayError);
      });
      hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          handleFatalStreamError(station);
        }
      });
    } else {
      // Native audio or Safari native HLS
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

  /** Handle fatal stream failure with fallback URL retry */
  function handleFatalStreamError(station) {
    if (retryCount === 0 && station.fallbackUrl && station.fallbackUrl !== station.streamUrl) {
      console.log('Retrying station with fallback URL...');
      retryCount++;
      startAudio(station);
    } else {
      console.error('Stream unavailable:', station.name);
      updatePlaybackState(false);
      if (playerTrack) playerTrack.textContent = `${station.name} (Stream Offline)`;
    }
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
  function playNext() {
    if (filteredStations.length === 0) return;
    const nextIdx = (currentIndex + 1) % filteredStations.length;
    playStation(filteredStations[nextIdx]);
  }

  /** Play previous station in current filter */
  function playPrevious() {
    if (filteredStations.length === 0) return;
    const prevIdx = (currentIndex - 1 + filteredStations.length) % filteredStations.length;
    playStation(filteredStations[prevIdx]);
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
      favPlayerBtn.classList.toggle('favorited', favorites.has(id));
    }
  }

  /** Update playback button and equalizer UI */
  function updatePlaybackState(playing) {
    isPlaying = playing;

    if (playIcon) playIcon.style.display = playing ? 'none' : 'inline-block';
    if (pauseIcon) pauseIcon.style.display = playing ? 'inline-block' : 'none';

    if (dmPlayIcon) dmPlayIcon.style.display = playing ? 'none' : 'inline-block';
    if (dmPauseIcon) dmPauseIcon.style.display = playing ? 'inline-block' : 'none';

    if (equalizer) {
      equalizer.style.opacity = playing ? '1' : '0.2';
    }

    renderStations();
  }

  /** Setup MediaSession API (Steering wheel & keyboard multimedia keys) */
  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
      navigator.mediaSession.setActionHandler('previoustrack', () => playPrevious());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    }
  }

  function updateMediaSession(station) {
    if ('mediaSession' in navigator && station) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: station.name,
        artist: `DriveWave • ${station.country || 'Live Radio'}`,
        album: 'DriveWave Web',
        artwork: [
          { src: station.favicon || 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
    }
  }

  /** Setup Event Listeners */
  function setupEventListeners() {
    // Audio events
    audio.addEventListener('playing', () => updatePlaybackState(true));
    audio.addEventListener('pause', () => updatePlaybackState(false));
    audio.addEventListener('waiting', () => { isBuffering = true; });
    audio.addEventListener('error', () => {
      if (currentStation) handleFatalStreamError(currentStation);
    });

    // Player bar controls
    if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayPause);
    if (prevBtn) prevBtn.addEventListener('click', playPrevious);
    if (nextBtn) nextBtn.addEventListener('click', playNext);

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

    // Nav Items (Moods)
    navItems.forEach(item => {
      item.addEventListener('click', () => {
        navItems.forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        currentMood = item.getAttribute('data-mood') || 'ALL';
        applyFilter();
      });
    });

    // Country Pills
    if (countryFilters) {
      countryFilters.querySelectorAll('.filter-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          countryFilters.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          currentCountry = pill.getAttribute('data-country') || 'ALL';
          applyFilter();
        });
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
    if (dmPlayPauseBtn) dmPlayPauseBtn.addEventListener('click', togglePlayPause);
    if (dmPrevBtn) dmPrevBtn.addEventListener('click', playPrevious);
    if (dmNextBtn) dmNextBtn.addEventListener('click', playNext);

    // Keyboard navigation (Space: Play/Pause, ArrowLeft: Prev, ArrowRight: Next)
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrevious();
      } else if (e.code === 'Escape') {
        if (drivingModeOverlay && drivingModeOverlay.classList.contains('active')) {
          drivingModeOverlay.classList.remove('active');
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
