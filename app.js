// ============================================================
// RISHI MUSIC - COMPLETE APP ENGINE (app.js)
// CONTINUOUS FULL PLAYBACK VERSION
// ============================================================

const DB_NAME = "RishiMusicDB";
const DB_VERSION = 3;
const STORE_NAME = "tracks";

let db = null;
let songs = [];
let currentIndex = -1;

let activeArtist = "all";
let searchQuery = "";
let isTransitioning = false;
let playbackGeneration = 0;
let activePlayPromise = null;
let playbackWatchdog = null;
let transitionTimer = null;

// These are retained for compatibility with the existing engine.
// They are NOT used to automatically skip songs.
let lastProgressTime = 0;
let lastProgressValue = 0;

// Unique shuffle/cycle pool
let unplayedQueue = [];

// Persistent Blob URL cache
const blobUrlCache = new WeakMap();

// ============================================================
// AUDIO ENGINE
// ============================================================

const audio = document.getElementById("audioEngine") || new Audio();

audio.id = "audioEngine";
audio.preload = "auto";
audio.setAttribute("playsinline", "true");

if (!document.getElementById("audioEngine")) {
    document.body.appendChild(audio);
}

// ============================================================
// DAILY NO-REPEAT ENGINE
// ============================================================

function getTodayKey() {
    const now = new Date();

    return `rishi_played_${now.getFullYear()}_${now.getMonth() + 1}_${now.getDate()}`;
}

function getDailyPlayedIds() {
    try {
        const data = localStorage.getItem(getTodayKey());

        return data ? JSON.parse(data) : [];
    } catch (e) {
        return [];
    }
}

function markSongPlayedToday(songId) {
    if (songId === undefined || songId === null) {
        return;
    }

    try {
        const key = getTodayKey();

        let played = getDailyPlayedIds();

        if (!played.includes(songId)) {
            played.push(songId);

            localStorage.setItem(
                key,
                JSON.stringify(played)
            );
        }
    } catch (e) {}
}

// ============================================================
// INDEXED DB
// ============================================================

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            DB_NAME,
            DB_VERSION
        );

        request.onupgradeneeded = (event) => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, {
                    keyPath: "id",
                    autoIncrement: true
                });
            }
        };

        request.onsuccess = () => {
            db = request.result;

            db.onversionchange = () => {
                db.close();
            };

            resolve(db);
        };

        request.onerror = () => {
            reject(request.error);
        };

        request.onblocked = () => {
            console.warn("IndexedDB blocked.");
        };
    });
}

function saveTrackToDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(
                new Error("Database is not ready")
            );
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.add(track);

        request.onsuccess = () => {
            resolve(request.result);
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

function loadAllTracksFromDB() {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(
                new Error("Database is not ready")
            );
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readonly"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.getAll();

        request.onsuccess = () => {
            resolve(
                Array.isArray(request.result)
                    ? request.result
                    : []
            );
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

function updateTrackInDB(track) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(
                new Error("Database is not ready")
            );
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.put(track);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

function deleteTrackFromDB(id) {
    return new Promise((resolve, reject) => {
        if (!db) {
            return reject(
                new Error("Database is not ready")
            );
        }

        const transaction = db.transaction(
            STORE_NAME,
            "readwrite"
        );

        const store = transaction.objectStore(
            STORE_NAME
        );

        const request = store.delete(id);

        request.onsuccess = () => {
            resolve();
        };

        request.onerror = () => {
            reject(request.error);
        };
    });
}

// ============================================================
// SONG HELPERS
// ============================================================

function getSongTitle(song) {
    return (
        song?.title ||
        song?.name ||
        "Unknown Song"
    );
}

function getSongArtist(song) {
    return String(
        song?.artist ||
        song?.director ||
        "Unknown Director"
    )
        .trim()
        .toUpperCase();
}

function getSongSource(song) {
    if (!song) {
        return null;
    }

    if (song.blob) {
        if (!blobUrlCache.has(song.blob)) {
            blobUrlCache.set(
                song.blob,
                URL.createObjectURL(song.blob)
            );
        }

        return blobUrlCache.get(song.blob);
    }

    if (song.url) {
        return song.url;
    }

    return null;
}

// ============================================================
// FILTERING & SMART SELECTION
// ============================================================

function getFilteredSongIndexes() {
    const result = [];

    const query = searchQuery
        .trim()
        .toLowerCase();

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        if (!song) {
            continue;
        }

        if (
            activeArtist !== "all" &&
            getSongArtist(song).toLowerCase() !==
                activeArtist.toLowerCase()
        ) {
            continue;
        }

        if (query) {
            const searchable = [
                getSongTitle(song),
                getSongArtist(song),
                song.name || "",
                song.director || ""
            ]
                .join(" ")
                .toLowerCase();

            if (!searchable.includes(query)) {
                continue;
            }
        }

        result.push(i);
    }

    return result;
}

function getAutomaticSongIndexes() {
    const result = [];

    for (let i = 0; i < songs.length; i++) {
        const song = songs[i];

        if (!song) {
            continue;
        }

        if (
            activeArtist !== "all" &&
            getSongArtist(song).toLowerCase() !==
                activeArtist.toLowerCase()
        ) {
            continue;
        }

        result.push(i);
    }

    return result;
}

function getNextSmartSongIndex() {
    const pool = getAutomaticSongIndexes();

    if (pool.length === 0) {
        return -1;
    }

    if (pool.length === 1) {
        return pool[0];
    }

    const todayPlayed = getDailyPlayedIds();

    let candidateIndexes = pool.filter(
        idx =>
            !todayPlayed.includes(
                songs[idx]?.id
            )
    );

    if (candidateIndexes.length === 0) {
        candidateIndexes = pool.slice();
    }

    unplayedQueue = unplayedQueue.filter(
        idx =>
            candidateIndexes.includes(idx)
    );

    if (unplayedQueue.length === 0) {
        unplayedQueue =
            candidateIndexes.filter(
                idx => idx !== currentIndex
            );

        if (unplayedQueue.length === 0) {
            unplayedQueue =
                candidateIndexes.slice();
        }

        for (
            let i = unplayedQueue.length - 1;
            i > 0;
            i--
        ) {
            const j = Math.floor(
                Math.random() * (i + 1)
            );

            [
                unplayedQueue[i],
                unplayedQueue[j]
            ] = [
                unplayedQueue[j],
                unplayedQueue[i]
            ];
        }
    }

    let chosenPointer = 0;

    if (
        activeArtist === "all" &&
        unplayedQueue.length > 1
    ) {
        const currentDirector =
            songs[currentIndex]
                ? getSongArtist(
                      songs[currentIndex]
                  )
                : null;

        const diffIndex =
            unplayedQueue.findIndex(
                idx =>
                    getSongArtist(
                        songs[idx]
                    ) !== currentDirector
            );

        if (diffIndex !== -1) {
            chosenPointer = diffIndex;
        }
    }

    return unplayedQueue.splice(
        chosenPointer,
        1
    )[0];
}

function formatTime(seconds) {
    if (
        !Number.isFinite(seconds) ||
        seconds < 0
    ) {
        return "0:00";
    }

    const minutes = Math.floor(
        seconds / 60
    );

    const remaining = Math.floor(
        seconds % 60
    );

    return `${minutes}:${String(
        remaining
    ).padStart(2, "0")}`;
}

// ============================================================
// PLAYER UI UPDATES
// ============================================================

function updatePlayerInformation(song) {
    const title =
        document.getElementById(
            "playerTitle"
        );

    const artist =
        document.getElementById(
            "playerArtist"
        );

    if (!song) {
        if (title) {
            title.textContent =
                "No track playing";
        }

        if (artist) {
            artist.textContent =
                "Select a song from your library";
        }

        return;
    }

    if (title) {
        title.textContent =
            getSongTitle(song);
    }

    if (artist) {
        artist.textContent =
            getSongArtist(song);
    }
}

function updatePlayButton() {
    const button =
        document.getElementById(
            "playBtn"
        );

    if (!button) {
        return;
    }

    button.textContent =
        audio.paused
            ? "▶"
            : "❚❚";
}

// ============================================================
// CONTINUOUS PLAYBACK ENGINE
// ============================================================

function clearPlaybackWatchdog() {
    if (playbackWatchdog) {
        clearTimeout(playbackWatchdog);
        playbackWatchdog = null;
    }

    if (transitionTimer) {
        clearTimeout(transitionTimer);
        transitionTimer = null;
    }
}

/*
 IMPORTANT:

 The previous version had a watchdog which did this:

    if (no timeupdate for 12 seconds)
        skip current song

 That is NOT safe for local Blob audio.

 A large song can temporarily stop producing timeupdate events because of:

 - browser buffering
 - phone background restrictions
 - Bluetooth/AirPods
 - screen lock
 - IndexedDB Blob loading
 - temporary browser scheduling

 Therefore this version NEVER skips a song merely because
 timeupdate stopped temporarily.

 The "ended" event is the normal and trusted signal
 for moving to the next song.
*/

function armPlaybackWatchdog(
    generation,
    index
) {
    clearPlaybackWatchdog();

    if (
        generation !== playbackGeneration ||
        index !== currentIndex
    ) {
        return;
    }

    /*
       Diagnostic timer only.

       IMPORTANT:
       It NEVER calls playNextAutomaticSong().
       It NEVER changes the current track.
       It NEVER reloads the audio.
    */

    const check = () => {
        if (
            generation !== playbackGeneration ||
            index !== currentIndex
        ) {
            return;
        }

        if (
            audio.paused ||
            audio.ended
        ) {
            return;
        }

        playbackWatchdog =
            setTimeout(
                check,
                5000
            );
    };

    playbackWatchdog =
        setTimeout(
            check,
            5000
        );
}

async function playSongAtIndex(
    index,
    isAuto = false
) {
    if (
        index < 0 ||
        index >= songs.length
    ) {
        return false;
    }

    const song = songs[index];

    if (!song) {
        return false;
    }

    const source =
        getSongSource(song);

    if (!source) {
        console.warn(
            "Unplayable track source. Skipping:",
            song
        );

        return false;
    }

    /*
       Every manual/new track gets a new generation.

       This prevents old play promises from controlling
       the newly selected track.
    */

    const currentGen =
        ++playbackGeneration;

    clearPlaybackWatchdog();

    activePlayPromise = null;

    try {
        audio.pause();

        audio.removeAttribute(
            "src"
        );

        audio.load();
    } catch (e) {
        console.warn(
            "Audio reset warning:",
            e
        );
    }

    currentIndex = index;

    audio.src = source;
    audio.preload = "auto";

    updatePlayerInformation(song);

    renderSongList();

    /*
       Marking the song as played does not modify
       the actual audio Blob.
    */

    markSongPlayedToday(
        song.id
    );

    try {
        const playPromise =
            audio.play();

        activePlayPromise =
            playPromise;

        await playPromise;

        if (
            activePlayPromise ===
            playPromise
        ) {
            activePlayPromise =
                null;
        }

        if (
            currentGen !==
            playbackGeneration
        ) {
            return false;
        }

        updatePlayButton();

        updateMediaSession(
            song
        );

        armPlaybackWatchdog(
            currentGen,
            index
        );

        return true;

    } catch (error) {
        if (
            activePlayPromise ===
            playPromise
        ) {
            activePlayPromise =
                null;
        }

        console.warn(
            "Playback error:",
            error
        );

        clearPlaybackWatchdog();

        if (
            currentGen ===
                playbackGeneration &&
            isAuto
        ) {
            return false;
        }

        updatePlayButton();

        return false;
    }
}

// ============================================================
// AUTOMATIC NEXT SONG
// ============================================================

async function playNextAutomaticSong() {
    if (isTransitioning) {
        return;
    }

    isTransitioning = true;

    clearPlaybackWatchdog();

    try {
        const pool =
            getAutomaticSongIndexes();

        if (pool.length === 0) {
            return;
        }

        let attempts = 0;

        const maxAttempts =
            Math.min(
                Math.max(
                    pool.length,
                    1
                ),
                8
            );

        while (
            attempts <
            maxAttempts
        ) {
            attempts++;

            const nextIdx =
                getNextSmartSongIndex();

            if (nextIdx === -1) {
                break;
            }

            const success =
                await playSongAtIndex(
                    nextIdx,
                    true
                );

            if (success) {
                return;
            }
        }

        /*
           Last-resort sequential attempt.

           This happens only when the selected candidate
           could not be started.
        */

        if (pool.length > 1) {
            const currentPos =
                pool.indexOf(
                    currentIndex
                );

            const nextPos =
                currentPos >= 0
                    ? (
                          currentPos + 1
                      ) % pool.length
                    : 0;

            await playSongAtIndex(
                pool[nextPos],
                true
            );
        }

    } finally {
        isTransitioning = false;
    }
}

// ============================================================
// PLAY / PAUSE
// ============================================================

async function togglePlay() {
    if (
        currentIndex === -1 ||
        !audio.src
    ) {
        await playNextAutomaticSong();
        return;
    }

    if (audio.paused) {
        try {
            await audio.play();
        } catch (e) {
            console.warn(
                "Resume failed:",
                e
            );
        }
    } else {
        audio.pause();
    }

    updatePlayButton();
}

function nextSong() {
    if (isTransitioning) {
        return;
    }

    playNextAutomaticSong();
}

async function prevSong() {
    if (isTransitioning) {
        return;
    }

    const filtered =
        getFilteredSongIndexes();

    if (filtered.length === 0) {
        return;
    }

    const pos =
        filtered.indexOf(
            currentIndex
        );

    const prevIndex =
        pos <= 0
            ? filtered[
                  filtered.length - 1
              ]
            : filtered[pos - 1];

    await playSongAtIndex(
        prevIndex,
        false
    );
}

// ============================================================
// EDIT & DELETE ACTIONS
// ============================================================

async function editSong(index) {
    const song =
        songs[index];

    if (!song) {
        return;
    }

    const newTitle =
        prompt(
            "Edit song title:",
            getSongTitle(song)
        );

    if (newTitle === null) {
        return;
    }

    const newDirector =
        prompt(
            "Edit music director:",
            getSongArtist(song)
        );

    if (newDirector === null) {
        return;
    }

    song.title =
        newTitle.trim() ||
        song.title;

    song.artist =
        newDirector.trim()
            .toUpperCase() ||
        song.artist;

    song.director =
        song.artist;

    if (
        song.id !== undefined &&
        song.id !== null
    ) {
        await updateTrackInDB(
            song
        );
    }

    updateArtistFilter();

    renderSongList();

    if (
        currentIndex === index
    ) {
        updatePlayerInformation(
            song
        );

        updateMediaSession(
            song
        );
    }
}

async function deleteSong(index) {
    const song =
        songs[index];

    if (!song) {
        return;
    }

    const confirmDelete =
        confirm(
            `Are you sure you want to delete "${getSongTitle(
                song
            )}"?`
        );

    if (!confirmDelete) {
        return;
    }

    if (
        song.id !== undefined &&
        song.id !== null
    ) {
        await deleteTrackFromDB(
            song.id
        );
    }

    if (
        currentIndex === index
    ) {
        audio.pause();

        audio.removeAttribute(
            "src"
        );

        audio.load();

        currentIndex = -1;

        updatePlayerInformation(
            null
        );

        updatePlayButton();
    } else if (
        currentIndex > index
    ) {
        currentIndex--;
    }

    songs.splice(
        index,
        1
    );

    unplayedQueue =
        unplayedQueue
            .filter(
                idx =>
                    idx !== index
            )
            .map(
                idx =>
                    idx > index
                        ? idx - 1
                        : idx
            );

    updateArtistFilter();

    updateSongCount();

    renderSongList();
}

// ============================================================
// MEDIA SESSION
// AIRPODS / BLUETOOTH / LOCK SCREEN
// ============================================================

function updateMediaSession(song) {
    if (
        !("mediaSession" in navigator) ||
        !song
    ) {
        return;
    }

    try {
        navigator.mediaSession.metadata =
            new MediaMetadata({
                title:
                    getSongTitle(
                        song
                    ),

                artist:
                    getSongArtist(
                        song
                    ),

                album:
                    "Rishi Music"
            });

        updateMediaPosition();

    } catch (e) {}
}

function updateMediaPosition() {
    if (
        !("mediaSession" in navigator)
    ) {
        return;
    }

    if (
        !Number.isFinite(
            audio.duration
        ) ||
        audio.duration <= 0
    ) {
        return;
    }

    try {
        if (
            "setPositionState" in
            navigator.mediaSession
        ) {
            navigator.mediaSession.setPositionState(
                {
                    duration:
                        audio.duration,

                    playbackRate:
                        audio.playbackRate ||
                        1,

                    position:
                        Math.min(
                            audio.currentTime,
                            audio.duration
                        )
                }
            );
        }
    } catch (e) {}
}

function setupMediaSession() {
    if (
        !("mediaSession" in navigator)
    ) {
        return;
    }

    navigator.mediaSession.setActionHandler(
        "play",
        () => togglePlay()
    );

    navigator.mediaSession.setActionHandler(
        "pause",
        () => {
            audio.pause();

            updatePlayButton();
        }
    );

    navigator.mediaSession.setActionHandler(
        "nexttrack",
        () => nextSong()
    );

    navigator.mediaSession.setActionHandler(
        "previoustrack",
        () => prevSong()
    );

    try {
        navigator.mediaSession.setActionHandler(
            "seekforward",
            details => {
                const skip =
                    details.seekOffset ||
                    10;

                audio.currentTime =
                    Math.min(
                        audio.duration ||
                            0,
                        audio.currentTime +
                            skip
                    );

                updateMediaPosition();
            }
        );

        navigator.mediaSession.setActionHandler(
            "seekbackward",
            details => {
                const skip =
                    details.seekOffset ||
                    10;

                audio.currentTime =
                    Math.max(
                        0,
                        audio.currentTime -
                            skip
                    );

                updateMediaPosition();
            }
        );

        navigator.mediaSession.setActionHandler(
            "seekto",
            details => {
                if (
                    details.seekTime !==
                        undefined &&
                    Number.isFinite(
                        details.seekTime
                    )
                ) {
                    audio.currentTime =
                        details.seekTime;

                    updateMediaPosition();
                }
            }
        );

    } catch (e) {}
}

// ============================================================
// ARTIST / DIRECTOR FILTER
// ============================================================

function getArtists() {
    const artists =
        new Set();

    songs.forEach(
        song => {
            const artist =
                getSongArtist(
                    song
                );

            if (
                artist &&
                artist !==
                    "UNKNOWN ARTIST" &&
                artist !==
                    "UNKNOWN DIRECTOR"
            ) {
                artists.add(
                    artist
                );
            }
        }
    );

    return Array.from(
        artists
    ).sort(
        (a, b) =>
            a.localeCompare(b)
    );
}

function updateArtistFilter() {
    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (!filter) {
        return;
    }

    filter.innerHTML = "";

    const allOption =
        document.createElement(
            "option"
        );

    allOption.value =
        "all";

    allOption.textContent =
        "ALL DIRECTORS";

    filter.appendChild(
        allOption
    );

    getArtists().forEach(
        artist => {
            const option =
                document.createElement(
                    "option"
                );

            option.value =
                artist;

            option.textContent =
                artist;

            filter.appendChild(
                option
            );
        }
    );

    const exists =
        Array.from(
            filter.options
        ).some(
            opt =>
                opt.value ===
                activeArtist
        );

    filter.value =
        exists
            ? activeArtist
            : "all";

    activeArtist =
        filter.value;
}

function updateSongCount() {
    const count =
        document.getElementById(
            "trackCountBadge"
        );

    if (count) {
        count.textContent =
            `${songs.length} song${
                songs.length === 1
                    ? ""
                    : "s"
            }`;
    }
}

// ============================================================
// RENDER SONG LIST
// ============================================================

function renderSongList() {
    const container =
        document.getElementById(
            "songListContainer"
        ) ||
        document.querySelector(
            ".song-list"
        );

    if (!container) {
        return;
    }

    const filtered =
        getFilteredSongIndexes();

    container.innerHTML = "";

    if (
        filtered.length === 0
    ) {
        const empty =
            document.createElement(
                "div"
            );

        empty.className =
            "empty-library";

        empty.style.padding =
            "24px";

        empty.style.textAlign =
            "center";

        empty.style.color =
            "rgba(255,255,255,0.5)";

        empty.textContent =
            songs.length === 0
                ? "No songs uploaded yet"
                : "No songs found";

        container.appendChild(
            empty
        );

        return;
    }

    const todayPlayed =
        getDailyPlayedIds();

    filtered.forEach(
        index => {
            const song =
                songs[index];

            const isCurrent =
                index ===
                currentIndex;

            const isPlaying =
                isCurrent &&
                !audio.paused;

            const playedToday =
                todayPlayed.includes(
                    song.id
                );

            const card =
                document.createElement(
                    "div"
                );

            card.className =
                "song-card" +
                (
                    isCurrent
                        ? " active"
                        : ""
                );

            card.style.display =
                "flex";

            card.style.alignItems =
                "center";

            card.style.justifyContent =
                "space-between";

            card.style.padding =
                "12px 16px";

            card.style.marginBottom =
                "8px";

            card.style.borderRadius =
                "14px";

            card.style.cursor =
                "pointer";

            card.style.transition =
                "all 0.25s ease";

            card.style.background =
                isCurrent
                    ? "linear-gradient(90deg, rgba(0, 150, 255, 0.22) 0%, rgba(14, 22, 36, 0.95) 100%)"
                    : "rgba(18, 22, 28, 0.85)";

            card.style.border =
                isCurrent
                    ? "1px solid rgba(0, 210, 255, 0.45)"
                    : "1px solid rgba(255, 255, 255, 0.05)";

            card.style.borderLeft =
                isCurrent
                    ? "4.5px solid #00d2ff"
                    : "4.5px solid transparent";

            card.style.boxShadow =
                isCurrent
                    ? "-4px 0 16px rgba(0, 210, 255, 0.4)"
                    : "none";

            // ====================================================
            // SONG INFORMATION
            // ====================================================

            const info =
                document.createElement(
                    "div"
                );

            info.className =
                "song-info";

            info.style.display =
                "flex";

            info.style.alignItems =
                "center";

            info.style.gap =
                "12px";

            info.style.overflow =
                "hidden";

            info.style.flex =
                "1";

            const icon =
                document.createElement(
                    "span"
                );

            icon.className =
                "song-icon";

            icon.textContent =
                "♫";

            icon.style.color =
                isCurrent
                    ? "#00d2ff"
                    : "#5a6e85";

            icon.style.fontSize =
                "1.1rem";

            icon.style.textShadow =
                isCurrent
                    ? "0 0 10px rgba(0, 210, 255, 0.8)"
                    : "none";

            const meta =
                document.createElement(
                    "div"
                );

            meta.className =
                "song-meta";

            meta.style.overflow =
                "hidden";

            const title =
                document.createElement(
                    "h4"
                );

            title.textContent =
                getSongTitle(
                    song
                );

            title.style.margin =
                "0";

            title.style.fontSize =
                "0.95rem";

            title.style.fontWeight =
                "600";

            title.style.color =
                isCurrent
                    ? "#70e1ff"
                    : "#ffffff";

            title.style.whiteSpace =
                "nowrap";

            title.style.overflow =
                "hidden";

            title.style.textOverflow =
                "ellipsis";

            const artist =
                document.createElement(
                    "p"
                );

            artist.textContent =
                getSongArtist(
                    song
                ) +
                (
                    playedToday
                        ? " • PLAYED TODAY"
                        : ""
                );

            artist.style.margin =
                "2px 0 0 0";

            artist.style.fontSize =
                "0.75rem";

            artist.style.color =
                "#72849a";

            artist.style.whiteSpace =
                "nowrap";

            artist.style.overflow =
                "hidden";

            artist.style.textOverflow =
                "ellipsis";

            meta.appendChild(
                title
            );

            meta.appendChild(
                artist
            );

            info.appendChild(
                icon
            );

            info.appendChild(
                meta
            );

            // ====================================================
            // ACTION BUTTONS
            // ====================================================

            const actions =
                document.createElement(
                    "div"
                );

            actions.className =
                "song-actions";

            actions.style.display =
                "flex";

            actions.style.alignItems =
                "center";

            actions.style.gap =
                "8px";

            // ====================================================
            // EDIT
            // ====================================================

            const editBtn =
                document.createElement(
                    "button"
                );

            editBtn.type =
                "button";

            editBtn.className =
                "btn-edit-action";

            editBtn.innerHTML =
                "✎ Edit";

            editBtn.style.padding =
                "6px 12px";

            editBtn.style.fontSize =
                "0.72rem";

            editBtn.style.fontWeight =
                "700";

            editBtn.style.color =
                "#8be3ff";

            editBtn.style.background =
                "linear-gradient(135deg, rgba(0, 180, 255, 0.2), rgba(0, 90, 200, 0.15))";

            editBtn.style.border =
                "1px solid rgba(0, 210, 255, 0.4)";

            editBtn.style.borderRadius =
                "20px";

            editBtn.style.cursor =
                "pointer";

            editBtn.style.backdropFilter =
                "blur(6px)";

            editBtn.style.boxShadow =
                "inset 0 1px 1px rgba(255,255,255,0.25)";

            editBtn.onclick =
                e => {
                    e.stopPropagation();

                    editSong(
                        index
                    );
                };

            // ====================================================
            // DELETE
            // ====================================================

            const deleteBtn =
                document.createElement(
                    "button"
                );

            deleteBtn.type =
                "button";

            deleteBtn.className =
                "btn-delete-action";

            deleteBtn.innerHTML =
                "🗑";

            deleteBtn.title =
                "Delete track";

            deleteBtn.style.width =
                "32px";

            deleteBtn.style.height =
                "32px";

            deleteBtn.style.borderRadius =
                "50%";

            deleteBtn.style.display =
                "flex";

            deleteBtn.style.alignItems =
                "center";

            deleteBtn.style.justifyContent =
                "center";

            deleteBtn.style.fontSize =
                "0.85rem";

            deleteBtn.style.color =
                "#ff7b88";

            deleteBtn.style.background =
                "linear-gradient(135deg, rgba(255, 60, 80, 0.2), rgba(180, 20, 40, 0.12))";

            deleteBtn.style.border =
                "1px solid rgba(255, 80, 100, 0.35)";

            deleteBtn.style.cursor =
                "pointer";

            deleteBtn.style.boxShadow =
                "inset 0 1px 1px rgba(255,255,255,0.15)";

            deleteBtn.onclick =
                e => {
                    e.stopPropagation();

                    deleteSong(
                        index
                    );
                };

            // ====================================================
            // PLAY / PAUSE
            // ====================================================

            const playButton =
                document.createElement(
                    "button"
                );

            playButton.type =
                "button";

            playButton.className =
                "play-mini";

            playButton.style.width =
                "36px";

            playButton.style.height =
                "36px";

            playButton.style.borderRadius =
                "50%";

            playButton.style.display =
                "flex";

            playButton.style.alignItems =
                "center";

            playButton.style.justifyContent =
                "center";

            playButton.style.border =
                "1px solid rgba(255, 255, 255, 0.4)";

            playButton.style.borderTop =
                "1px solid #ffffff";

            playButton.style.background =
                isPlaying
                    ? "linear-gradient(145deg, #00f0ff, #0072ce)"
                    : "linear-gradient(145deg, #2da0ff, #0056cc)";

            playButton.style.boxShadow =
                "inset 0 1px 2px rgba(255,255,255,0.6), 0 4px 12px rgba(0, 130, 255, 0.45)";

            playButton.style.color =
                "#fff";

            playButton.style.cursor =
                "pointer";

            playButton.textContent =
                isPlaying
                    ? "❚❚"
                    : "▶";

            playButton.onclick =
                e => {
                    e.stopPropagation();

                    if (isCurrent) {
                        togglePlay();
                    } else {
                        playSongAtIndex(
                            index,
                            false
                        );
                    }
                };

            actions.appendChild(
                editBtn
            );

            actions.appendChild(
                deleteBtn
            );

            actions.appendChild(
                playButton
            );

            card.appendChild(
                info
            );

            card.appendChild(
                actions
            );

            card.onclick =
                () =>
                    playSongAtIndex(
                        index,
                        false
                    );

            container.appendChild(
                card
            );
        }
    );
}

// ============================================================
// IMPORT SONGS
// ============================================================

async function importSongs(
    files
) {
    if (
        !files ||
        files.length === 0
    ) {
        return;
    }

    if (!db) {
        alert(
            "Music library is still loading. Please try again."
        );

        return;
    }

    for (const file of files) {
        if (
            !file.type.startsWith(
                "audio/"
            )
        ) {
            continue;
        }

        const defaultName =
            file.name
                .replace(
                    /\.[^/.]+$/,
                    ""
                )
                .trim();

        let songName =
            prompt(
                `Enter song name for "${file.name}":`,
                defaultName
            );

        if (
            songName === null
        ) {
            continue;
        }

        songName =
            songName.trim() ||
            defaultName;

        let musicDirector =
            prompt(
                `Enter music director for "${songName}":`,
                "Unknown Director"
            );

        if (
            musicDirector ===
            null
        ) {
            musicDirector =
                "Unknown Director";
        }

        musicDirector =
            musicDirector
                .trim()
                .toUpperCase() ||
            "UNKNOWN DIRECTOR";

        const track = {
            title: songName,

            name: file.name,

            artist:
                musicDirector,

            director:
                musicDirector,

            blob: file,

            type:
                file.type,

            size:
                file.size,

            createdAt:
                Date.now()
        };

        try {
            const id =
                await saveTrackToDB(
                    track
                );

            track.id = id;

            songs.push(
                track
            );

        } catch (e) {
            console.error(
                "Save error:",
                file.name,
                e
            );
        }
    }

    songs.sort(
        (a, b) =>
            (a.id || 0) -
            (b.id || 0)
    );

    unplayedQueue = [];

    updateArtistFilter();

    updateSongCount();

    renderSongList();

    const input =
        document.getElementById(
            "audioFileInput"
        );

    if (input) {
        input.value = "";
    }
}

// ============================================================
// AUDIO EVENTS
// ============================================================

audio.addEventListener(
    "play",
    () => {
        updatePlayButton();

        renderSongList();

        if (
            "mediaSession" in
            navigator
        ) {
            try {
                navigator.mediaSession.playbackState =
                    "playing";
            } catch (e) {}
        }

        if (
            currentIndex >= 0
        ) {
            armPlaybackWatchdog(
                playbackGeneration,
                currentIndex
            );
        }
    }
);

audio.addEventListener(
    "pause",
    () => {
        clearPlaybackWatchdog();

        updatePlayButton();

        renderSongList();

        if (
            "mediaSession" in
            navigator
        ) {
            try {
                navigator.mediaSession.playbackState =
                    "paused";
            } catch (e) {}
        }
    }
);

// ============================================================
// THIS IS THE MAIN AUTO-NEXT EVENT
// ============================================================

audio.addEventListener(
    "ended",
    () => {
        clearPlaybackWatchdog();

        /*
           IMPORTANT:

           A song is allowed to finish completely.

           Only the genuine "ended" event starts
           the next song.
        */

        if (!isTransitioning) {
            playNextAutomaticSong();
        }
    }
);

// ============================================================
// AUDIO ERROR
// ============================================================

audio.addEventListener(
    "error",
    e => {
        console.error(
            "Audio error encountered:",
            audio.error || e
        );

        clearPlaybackWatchdog();

        /*
           IMPORTANT:

           Do NOT automatically skip here.

           Some browsers can report temporary media
           errors while a local Blob is loading.

           The normal automatic next-song mechanism
           is handled by "ended".
        */

        updatePlayButton();
    }
);

// ============================================================
// STALLED
// ============================================================

audio.addEventListener(
    "stalled",
    () => {
        console.warn(
            "Audio temporarily stalled. Current track will NOT be skipped."
        );
    }
);

// ============================================================
// WAITING
// ============================================================

audio.addEventListener(
    "waiting",
    () => {
        console.warn(
            "Audio temporarily waiting for data. Current track will NOT be skipped."
        );
    }
);

// ============================================================
// CAN PLAY
// ============================================================

audio.addEventListener(
    "canplay",
    () => {
        /*
           Browser has enough data to continue playback.

           We intentionally do not change tracks here.
        */

        if (
            !audio.paused &&
            !audio.ended
        ) {
            updatePlayButton();
        }
    }
);

// ============================================================
// LOADED METADATA
// ============================================================

audio.addEventListener(
    "loadedmetadata",
    () => {
        const totalTime =
            document.getElementById(
                "totalTime"
            );

        if (totalTime) {
            totalTime.textContent =
                formatTime(
                    audio.duration
                );
        }

        updateMediaPosition();
    }
);

// ============================================================
// TIME UPDATE
// ============================================================

audio.addEventListener(
    "timeupdate",
    () => {
        const currentTime =
            document.getElementById(
                "currentTime"
            );

        const progressBar =
            document.getElementById(
                "progressBar"
            );

        if (currentTime) {
            currentTime.textContent =
                formatTime(
                    audio.currentTime
                );
        }

        if (
            progressBar &&
            Number.isFinite(
                audio.duration
            ) &&
            audio.duration > 0
        ) {
            progressBar.value =
                (
                    audio.currentTime /
                    audio.duration
                ) * 100;
        }

        updateMediaPosition();
    }
);

// ============================================================
// CONTROL SETUP
// ============================================================

function setupControls() {
    const importInput =
        document.getElementById(
            "audioFileInput"
        );

    if (importInput) {
        importInput.addEventListener(
            "change",
            e => {
                importSongs(
                    Array.from(
                        e.target.files
                    )
                );
            }
        );
    }

    document
        .getElementById(
            "playBtn"
        )
        ?.addEventListener(
            "click",
            togglePlay
        );

    document
        .getElementById(
            "nextBtn"
        )
        ?.addEventListener(
            "click",
            nextSong
        );

    document
        .getElementById(
            "prevBtn"
        )
        ?.addEventListener(
            "click",
            prevSong
        );

    const searchInput =
        document.getElementById(
            "searchInput"
        );

    if (searchInput) {
        searchInput.addEventListener(
            "input",
            () => {
                searchQuery =
                    searchInput.value;

                renderSongList();
            }
        );
    }

    const filter =
        document.getElementById(
            "directorFilter"
        );

    if (filter) {
        filter.addEventListener(
            "change",
            () => {
                activeArtist =
                    filter.value;

                unplayedQueue = [];

                renderSongList();
            }
        );
    }

    const progressBar =
        document.getElementById(
            "progressBar"
        );

    if (progressBar) {
        progressBar.addEventListener(
            "input",
            () => {
                if (
                    Number.isFinite(
                        audio.duration
                    ) &&
                    audio.duration > 0
                ) {
                    audio.currentTime =
                        (
                            Number(
                                progressBar.value
                            ) / 100
                        ) *
                        audio.duration;
                }
            }
        );
    }

    const muteBtn =
        document.getElementById(
            "muteBtn"
        );

    if (muteBtn) {
        muteBtn.addEventListener(
            "click",
            () => {
                audio.muted =
                    !audio.muted;

                muteBtn.textContent =
                    audio.muted
                        ? "🔇"
                        : "🔊";
            }
        );
    }

    const volumeBar =
        document.getElementById(
            "volumeBar"
        );

    if (volumeBar) {
        audio.volume =
            Number(
                volumeBar.value
            );

        volumeBar.addEventListener(
            "input",
            () => {
                audio.volume =
                    Number(
                        volumeBar.value
                    );

                audio.muted =
                    audio.volume === 0;
            }
        );
    }
}

// ============================================================
// INITIALIZE
// ============================================================

async function initializeApp() {
    try {
        /*
           Request persistent browser storage.

           This helps prevent browser storage eviction.
           It does NOT delete or rewrite your songs.
        */

        if (
            navigator.storage &&
            navigator.storage.persist
        ) {
            try {
                await navigator.storage.persist();
            } catch (e) {}
        }

        await openDatabase();

        songs =
            await loadAllTracksFromDB();

        songs.sort(
            (a, b) =>
                (a.id || 0) -
                (b.id || 0)
        );

        updateArtistFilter();

        updateSongCount();

        renderSongList();

        updatePlayerInformation(
            null
        );

        updatePlayButton();

        setupMediaSession();

    } catch (error) {
        console.error(
            "Initialization failed:",
            error
        );
    }
}

// ============================================================
// START APP
// ============================================================

document.addEventListener(
    "DOMContentLoaded",
    async () => {
        setupControls();

        await initializeApp();
    }
);

// ============================================================
// SERVICE WORKER
// ============================================================

if (
    "serviceWorker" in
    navigator
) {
    window.addEventListener(
        "load",
        () => {
            navigator.serviceWorker
                .register(
                    "./sw.js?v=7"
                )
                .catch(
                    () => {}
                );
        }
    );
}

// ============================================================
// PAGE CLOSE
// ============================================================

window.addEventListener(
    "beforeunload",
    () => {
        clearPlaybackWatchdog();

        if (audio) {
            audio.pause();
        }

        playbackGeneration++;
    }
);
