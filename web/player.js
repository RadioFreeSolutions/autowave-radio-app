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
  let searchQuery = '';
  let hlsInstance = null;
  let retryCount = 0;
  let consecutiveAutoSkips = 0;
  const MAX_AUTO_SKIPS = 3;

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

  // Floating Corner Mini Widget Elements
  const cornerMiniWidget = document.getElementById('corner-mini-widget');
  const btnMiniClose = document.getElementById('btn-mini-close');
  const miniArt = document.getElementById('mini-art');
  const miniTitle = document.getElementById('mini-title');
  const miniSub = document.getElementById('mini-sub');
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
    FAVORITES: { title: '⭐ Favorites', subtitle: 'Your saved road-trip radio stations.' }
  };

  /** Initialize App */
  function init() {
    updateBadges();
    applyFilter();
    setupEventListeners();
    setupMediaSession();

    if (searchInput) {
      searchInput.placeholder = `Search ${stations.length} stations, genres, or artists...`;
    }

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

    const mobileFavBadge = document.getElementById('mobile-fav-badge');
    if (mobileFavBadge) {
      mobileFavBadge.textContent = favorites.size;
    }
  }

  /** Filter stations based on mood and search query */
  function applyFilter() {
    filteredStations = stations.filter(s => {
      // Mood match
      if (currentMood === 'FAVORITES') {
        if (!favorites.has(s.id)) return false;
      } else if (currentMood !== 'ALL') {
        if (!s.moods || !s.moods.includes(currentMood)) return false;
      }

      // Search match
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const combined = `${s.name} ${s.country} ${(s.tags || []).join(' ')}`.toLowerCase();
        if (!combined.includes(q)) return false;
      }

      return true;
    });

    // Update shelf title and subtitle dynamically
    const meta = MOOD_META[currentMood] || MOOD_META.ALL;
    if (shelfTitle) shelfTitle.innerHTML = meta.title + ` <span style="font-size: 16px; color: var(--accent); font-weight: 600;">(${filteredStations.length})</span>`;
    if (shelfSubtitle) {
      if (currentMood === 'ALL' && !searchQuery) {
        shelfSubtitle.textContent = `${stations.length} hand-picked, verified live radio broadcasts.`;
      } else {
        shelfSubtitle.textContent = meta.subtitle;
      }
    }

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
    if (miniArt) miniArt.src = artUrl;

    if (playerTrack) playerTrack.textContent = station.name;
    if (dmTrackTitle) dmTrackTitle.textContent = station.name;
    if (miniTitle) miniTitle.textContent = station.name;

    const subtitleText = `${station.flag} ${station.country || 'Live'} • Live Stream`;
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
      favPlayerBtn.classList.toggle('favorited', favorites.has(station.id));
    }

    localStorage.setItem(LS_LAST_STATION, station.id);

    updateDocumentPipUI();
    renderVideoPipFrame();

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

  let icyAbortController = null;
  let currentTrackTitle = '';

  function cleanStreamTitle(raw) {
    if (!raw) return "";
    let title = raw.trim();
    // Handle StreamTitle='...' or StreamTitle="..." or StreamTitle=...
    const match = title.match(/^StreamTitle=['"]?(.*?)['"]?(?:;.*)?$/i);
    if (match) title = match[1].trim();

    // Handle artist=...;title=...
    const atMatch = title.match(/^artist=['"]?(.*?)['"]?[;,]\s*title=['"]?(.*?)['"]?$/i);
    if (atMatch) {
      const a = atMatch[1].trim();
      const t = atMatch[2].trim();
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
    ['song_spot=', 'MediaBaseId=', 'itunesTrackId=', 'amgTrackId=', 'amgArtistId=', 'StreamUrl='].forEach(k => {
      const idx = title.toLowerCase().indexOf(k.toLowerCase());
      if (idx > 0) title = title.substring(0, idx).trim();
    });

    title = title.replace(/^text=['"]?(.*?)['"]?$/i, '$1');
    title = title.replace(/\s*-\s*AD\s*BREAK\s*$/i, '');
    title = title.replace(/\s*-\s*COMMERCIAL\s*$/i, '');
    title = title.replace(/\s*-\s*STATION\s*ID\s*$/i, '');
    title = title.replace(/^(?:NOW PLAYING|NOW ON AIR|LIVE|NP):\s*/i, '');
    return title.trim().replace(/^['"`\s-]+|['"`\s-;]+$/g, '');
  }

  let adBlockEnabled = localStorage.getItem('drivewave_ad_block') !== 'false';
  let lastAdSkipTime = 0;

  function isAdBreak(title) {
    if (!title) return false;
    return /(?:\bAD\b|\bAD_BREAK\b|\bADBREAK\b|\bCOMMERCIAL\b|\bADVERT\b|\bADVERTISEMENT\b|\bSPONSOR\b|^AD\s*[-:]|[-:]\s*AD$)/i.test(title);
  }

  function onNewTrackInfo(track, station) {
    if (!track) return;

    if (adBlockEnabled && isAdBreak(track)) {
      const now = Date.now();
      if (now - lastAdSkipTime > 3000) {
        lastAdSkipTime = now;
        console.log(`[Ad Block] Ad detected ('${track}') - skipping to next station`);
        if (playerTrack) {
          playerTrack.textContent = '🛡️ Ad Detected — Skipping...';
        }
        setTimeout(() => playNext(), 600);
        return;
      }
    }

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
    updateTabTitle();
  }

  function startMetadataStream(station) {
    if (icyAbortController) {
      try { icyAbortController.abort(); } catch (e) {}
      icyAbortController = null;
    }
    currentTrackTitle = '';

    const streamUrl = (retryCount > 0 && station.fallbackUrl) ? station.fallbackUrl : station.streamUrl;
    if (!streamUrl || station.isHls || streamUrl.includes('.m3u8')) return;

    try {
      icyAbortController = new AbortController();
      const signal = icyAbortController.signal;

      fetch(streamUrl, {
        headers: { 'Icy-MetaData': '1' },
        signal: signal,
        mode: 'cors'
      }).then(response => {
        const metaint = parseInt(response.headers.get('icy-metaint'), 10);
        if (!metaint || !response.body) return;

        const reader = response.body.getReader();
        let byteCounter = 0;
        let readingMeta = false;
        let metaLength = 0;
        let metaBuffer = [];

        function pump() {
          return reader.read().then(({ done, value }) => {
            if (done || signal.aborted) return;
            const chunk = value;
            let offset = 0;

            while (offset < chunk.length) {
              if (!readingMeta) {
                const remaining = metaint - byteCounter;
                if (offset + remaining <= chunk.length) {
                  offset += remaining;
                  byteCounter = 0;
                  readingMeta = true;
                  if (offset < chunk.length) {
                    metaLength = chunk[offset] * 16;
                    offset += 1;
                    metaBuffer = [];
                    if (metaLength === 0) readingMeta = false;
                  }
                } else {
                  byteCounter += (chunk.length - offset);
                  offset = chunk.length;
                }
              } else {
                if (metaBuffer.length < metaLength) {
                  const need = metaLength - metaBuffer.length;
                  const available = chunk.length - offset;
                  const take = Math.min(need, available);
                  for (let i = 0; i < take; i++) {
                    metaBuffer.push(chunk[offset + i]);
                  }
                  offset += take;
                  if (metaBuffer.length >= metaLength) {
                    readingMeta = false;
                    byteCounter = 0;
                    try {
                      const rawStr = new TextDecoder('utf-8').decode(new Uint8Array(metaBuffer));
                      const match = rawStr.match(/StreamTitle='(.*?)';/);
                      if (match && match[1]) {
                        const cleaned = cleanStreamTitle(match[1]);
                        if (cleaned && cleaned.toLowerCase() !== station.name.toLowerCase()) {
                          onNewTrackInfo(cleaned, station);
                        }
                      }
                    } catch (e) {}
                  }
                }
              }
            }
            return pump();
          }).catch(() => {});
        }
        return pump();
      }).catch(() => {});
    } catch (e) {}
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
      audio.src = streamUrl;
      audio.play().catch(handlePlayError);
    }

    startMetadataStream(station);
    updateMediaSession(station);
  }

  /** Handle play promise error */
  function handlePlayError(err) {
    console.warn('Playback error or blocked by autoplay:', err);
    updatePlaybackState(false);
  }

  /** Handle fatal stream failure with fallback URL retry and smooth auto-advance */
  function handleFatalStreamError(station) {
    if (retryCount === 0 && station.fallbackUrl && station.fallbackUrl !== station.streamUrl) {
      console.log('Retrying station with fallback URL...');
      retryCount++;
      startAudio(station);
      return;
    }

    console.warn('Stream unavailable:', station.name);
    // Smooth auto-fallback: advance to next station so driver is never left in silence
    if (consecutiveAutoSkips < MAX_AUTO_SKIPS && filteredStations.length > 1) {
      consecutiveAutoSkips++;
      if (playerTrack) playerTrack.textContent = `${station.name} (Connecting next...)`;
      setTimeout(() => {
        playNext();
      }, 800);
    } else {
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
        document.title = `▶ ${title} | DriveWave`;
      } else {
        document.title = `⏸ DriveWave Web`;
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
      const title = currentStation ? currentStation.name : 'DriveWave Radio';
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
    grad.addColorStop(0, 'rgba(0, 229, 255, 0.15)');
    grad.addColorStop(1, 'rgba(7, 10, 16, 0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    const name = currentStation ? currentStation.name : 'DriveWave Radio';
    ctx.fillText(name, w / 2, 75);

    ctx.fillStyle = '#00E5FF';
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
      ctx.fillStyle = '#00E5FF';
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
      .pip-art { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: #121826; flex-shrink: 0; border: 1px solid rgba(0, 229, 255, 0.3); }
      .pip-info { flex: 1; min-width: 0; overflow: hidden; }
      .pip-title { font-size: 14px; font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #FFF; }
      .pip-sub { font-size: 12px; color: #00E5FF; font-weight: 600; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pip-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .pip-btn { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #FFF; border-radius: 50%; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 14px; transition: all 0.2s; }
      .pip-btn:hover { background: rgba(255,255,255,0.2); }
      .pip-play { background: linear-gradient(135deg, #00E5FF 0%, #00B0FF 100%); color: #000; width: 40px; height: 40px; font-size: 16px; border: none; font-weight: bold; }
      .pip-play:hover { transform: scale(1.05); }
    `;
    pipWindow.document.head.appendChild(style);

    const art = currentStation ? (currentStation.favicon || 'icon-512.png') : 'icon-512.png';
    const title = currentStation ? currentStation.name : 'DriveWave Radio';
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

  function updateMediaSession(station, track = '') {
    if ('mediaSession' in navigator && station) {
      const displayTitle = track || station.name;
      const displayArtist = track ? `${station.name} • DriveWave` : `DriveWave • ${station.country || 'Live Radio'}`;
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
    if (dmPlayPauseBtn) dmPlayPauseBtn.addEventListener('click', togglePlayPause);
    if (dmPrevBtn) dmPrevBtn.addEventListener('click', playPrevious);
    if (dmNextBtn) dmNextBtn.addEventListener('click', playNext);

    // Corner Mini Widget controls
    if (btnMiniClose) {
      btnMiniClose.addEventListener('click', (e) => {
        e.stopPropagation();
        miniManuallyClosed = true;
        hideMiniWidget();
      });
    }
    if (btnMiniPlay) btnMiniPlay.addEventListener('click', togglePlayPause);
    if (btnMiniPrev) btnMiniPrev.addEventListener('click', playPrevious);
    if (btnMiniNext) btnMiniNext.addEventListener('click', playNext);
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

    // Keyboard navigation (Space: Play/Pause, ArrowLeft: Prev, ArrowRight: Next, Escape: Close modal/cockpit)
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
