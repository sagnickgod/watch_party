const socket = io();
let currentRoom = null;
let isHost = false;
let webtorrentClient = null;
let currentTorrent = null;
let ignoreSyncEvents = false;
let myUsername = 'Anonymous';
let hostedFile = null; // Stores the local File object for the Host Serverless Proxy

// DOM Elements
const setupView = document.getElementById('setup-screen');
const roomView = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const usernameInput = document.getElementById('username');
const roomIdInput = document.getElementById('room-id');

// Nav & Info
const displayRoomId = document.getElementById('display-room-id');
const copyLinkBtn = document.getElementById('copy-link-btn');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const connectionStatus = document.getElementById('connection-status');
const hostControls = document.getElementById('host-controls');

// Video Player Elements
const videoContainer = document.getElementById('video-container');
const videoPlaceholder = document.getElementById('video-placeholder');
const bufferingSpinner = document.getElementById('buffering-spinner');
const bufferText = document.getElementById('buffer-text');
const peerOverlay = document.getElementById('peer-overlay');
const peerCountDisplay = document.getElementById('peer-count');
const customControls = document.getElementById('custom-controls');

// Custom Video Controls
const playPauseBtn = document.getElementById('play-pause-btn');
const playPauseIcon = playPauseBtn.querySelector('i');
const progressBar = document.getElementById('progress-bar');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const volumeSlider = document.getElementById('volume-slider');
const muteBtn = document.getElementById('mute-btn');

// Sidebar Tabs & Content
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const usersList = document.getElementById('users-list');
const userCountBadge = document.getElementById('user-count-badge');

// Torrent & Media Inputs
const torrentFileInput = document.getElementById('torrent-file-input');
const loadMediaBtn = document.getElementById('load-media-btn');
const magnetInput = document.getElementById('magnet-input');
const directUrlInput = document.getElementById('direct-url-input');

// Webtorrent trackers configuration
const trackerOpts = {
    announce: [
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.btorrent.xyz',
        'wss://tracker.fastcast.nz',
        // Common public WebSocket trackers to improve peer discovery
        'wss://tracker.webtorrent.dev'
    ]
};

// Initial Setup
usernameInput.value = localStorage.getItem('username') || '';
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('room')) {
    roomIdInput.value = urlParams.get('room');
}

// ----------------------------------------------------
// 1. Join / Leave Room
// ----------------------------------------------------

joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myUsername = usernameInput.value.trim();
    localStorage.setItem('username', myUsername);

    let roomId = roomIdInput.value.trim();
    if (!roomId) {
        // Generate random room ID if empty
        roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    // Connect & Join
    socket.emit('join-room', { roomId, username: myUsername });
    currentRoom = roomId;

    // Update UI
    setupView.classList.remove('active');
    roomView.classList.add('active');
    displayRoomId.textContent = roomId;

    // Set URL so users can copy
    window.history.pushState({}, '', '?room=' + roomId);
});

leaveRoomBtn.addEventListener('click', () => {
    window.location.href = window.location.pathname; // Reload app
});

copyLinkBtn.addEventListener('click', () => {
    const url = window.location.origin + '?room=' + currentRoom;
    navigator.clipboard.writeText(url);

    const originalHTML = copyLinkBtn.innerHTML;
    copyLinkBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
    copyLinkBtn.style.backgroundColor = 'var(--success)';

    setTimeout(() => {
        copyLinkBtn.innerHTML = originalHTML;
        copyLinkBtn.style.backgroundColor = '';
    }, 2000);
});

// ----------------------------------------------------
// 2. Socket Events (Room & Chat)
// ----------------------------------------------------

socket.on('connect', () => {
    connectionStatus.innerHTML = '<i class="fas fa-circle text-success"></i> Connected';
});

socket.on('disconnect', () => {
    connectionStatus.innerHTML = '<i class="fas fa-circle text-primary"></i> Disconnected';
});

socket.on('room-joined', (data) => {
    isHost = data.isHost;
    updateRoleUI();
    updateUsersList(data.users);

    // Clean start WebTorrent
    initWebTorrent();

    if (data.torrentId) {
        if (typeof data.torrentId === 'string' && (data.torrentId.startsWith('http') || data.torrentId.startsWith('/stream/'))) {
            loadDirectUrl(data.torrentId);
        } else {
            loadTorrent(data.torrentId);
        }
    }
});

socket.on('new-host', (hostId) => {
    isHost = (socket.id === hostId);
    updateRoleUI();
    addSystemMessage("The host disconnected. A new host has been assigned.");
});

socket.on('update-users', (users) => {
    updateUsersList(users);
});

socket.on('new-torrent', (mediaPayload) => {
    // If string, check if it's a direct URL or proxy stream URL
    if (typeof mediaPayload === 'string') {
        if (mediaPayload.startsWith('http') || mediaPayload.startsWith('/stream/')) {
            addSystemMessage("Host changed the video stream. Loading HD Stream...");
            loadDirectUrl(mediaPayload);
            return;
        }
    }
    addSystemMessage("Host changed the video stream. Loading torrent...");
    loadTorrent(mediaPayload);
});

// Host Serverless Proxy System: Respond to Byte Range Requests from the Server
socket.on('request-chunk', async ({ reqId, start, end }) => {
    if (!hostedFile) return;
    try {
        const slice = hostedFile.slice(start, end + 1);
        const buffer = await slice.arrayBuffer();
        socket.emit('chunk-response', { reqId, data: buffer });
    } catch (err) {
        console.error("Error reading file slice for proxy stream", err);
    }
});

socket.on('user-joined', (data) => {
    addSystemMessage(`${data.username} joined the room.`);
});

socket.on('user-left', (data) => {
    addSystemMessage(`${data.username} left the room.`);
});

function updateRoleUI() {
    if (isHost) {
        hostControls.classList.remove('hidden');
        customControls.classList.remove('hidden');
        peerOverlay.classList.add('hidden'); // Host can interact with player
    } else {
        hostControls.classList.add('hidden');
        customControls.classList.add('hidden');
        peerOverlay.classList.remove('hidden'); // Block peers from clicking
    }
}

function updateUsersList(users) {
    usersList.innerHTML = '';
    const userIds = Object.keys(users);
    userCountBadge.textContent = userIds.length;

    userIds.forEach(id => {
        const user = users[id];
        const li = document.createElement('li');
        li.className = 'user-item';

        let html = `<i class="fas fa-user-circle"></i> <span>${user.username}</span>`;

        if (user.isHost) {
            html += ' <span class="host-badge">HOST</span>';
        }
        if (id === socket.id) {
            html += ' <span class="you-badge">(You)</span>';
        }

        li.innerHTML = html;
        usersList.appendChild(li);
    });
}

// ----------------------------------------------------
// 3. WebTorrent & Video Management
// ----------------------------------------------------

function initWebTorrent() {
    if (webtorrentClient) {
        webtorrentClient.destroy();
    }

    // Configure WebTorrent with Google STUN servers to punch through NAT firewalls
    // This is often required for browsers to connect to desktop WebRTC peers
    const rtcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };

    webtorrentClient = new WebTorrent({
        tracker: trackerOpts,
        rtcConfig: rtcConfig
    });

    webtorrentClient.on('error', (err) => {
        console.error("WebTorrent error:", err);
        addSystemMessage(`WebTorrent error: ${err.message}`);
    });

    webtorrentClient.on('torrent', (torrent) => {
        console.log("Torrent initialized:", torrent.infoHash);

        torrent.on('wire', (wire, addr) => {
            console.log("Connected to peer:", addr);
        });

        torrent.on('warning', (err) => {
            console.warn("Torrent warning:", err);
        });

        torrent.on('trackerWarning', (err) => {
            console.warn("Tracker warning:", err);
        });
    });
}

// Host selects a file
torrentFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0 && isHost) {
        const file = e.target.files[0];

        // Check if the user selected a .torrent metadata file
        if (file.name.endsWith('.torrent') || file.type === 'application/x-bittorrent') {
            addSystemMessage(`Loading metadata from ${file.name}...`);
            showBuffering("Reading torrent file...");

            const reader = new FileReader();
            reader.onload = (event) => {
                const arrayBuffer = event.target.result;
                const buffer = webtorrentClient.webtorrent.Buffer ?
                    webtorrentClient.webtorrent.Buffer.from(arrayBuffer) :
                    new Uint8Array(arrayBuffer);

                webtorrentClient.add(buffer, trackerOpts, (torrent) => {
                    trackerOpts.announce.forEach(t => {
                        if (!torrent.announce.includes(t)) {
                            torrent.announce.push(t);
                        }
                    });
                    if (torrent.discovery && torrent.discovery.setAnnounce) {
                        torrent.discovery.setAnnounce(torrent.announce);
                    }

                    socket.emit('set-torrent', torrent.magnetURI);
                    onTorrentReady(torrent);
                });
            };
            reader.readAsArrayBuffer(file);

        } else {
            // User selected an actual video file (mp4, mkv). Bypass upload and stream via Serverless Proxy!
            hostedFile = file;
            addSystemMessage(`Setting up ${file.name} for Instant Zero-Upload Streaming...`);

            const fileData = {
                name: file.name,
                size: file.size,
                type: file.type || (file.name.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4')
            };

            socket.emit('host-file', fileData);

            // Host gets 0-latency instant playback directly from local memory!
            const objectUrl = URL.createObjectURL(file);
            addSystemMessage("Zero-Upload Streaming ready. Broadcasting stream to network...");
            loadDirectUrl(objectUrl);

            // Note: We don't revokeObjectURL here because the host needs it to seek/play indefinitely
        }
    }
});

// Host loads magnet or direct URL
loadMediaBtn.addEventListener('click', () => {
    const magnet = magnetInput.value.trim();
    const directUrl = directUrlInput.value.trim();

    if (directUrl && isHost) {
        addSystemMessage("Loading direct video URL...");
        socket.emit('set-torrent', directUrl);
        loadDirectUrl(directUrl);
        // Clear other inputs
        magnetInput.value = '';
    } else if (magnet && isHost) {
        addSystemMessage("Loading magnet link...");
        socket.emit('set-torrent', magnet);

        showBuffering("Finding peers...");
        if (currentTorrent) {
            webtorrentClient.remove(currentTorrent.infoHash);
        }

        webtorrentClient.add(magnet, trackerOpts, (torrent) => {
            // Force the discovery module to use the WebSocket trackers
            trackerOpts.announce.forEach(t => {
                if (!torrent.announce.includes(t)) {
                    torrent.announce.push(t);
                }
            });
            if (torrent.discovery && torrent.discovery.setAnnounce) {
                torrent.discovery.setAnnounce(torrent.announce);
            }

            onTorrentReady(torrent);
        });

        // Clear other inputs
        directUrlInput.value = '';
    }
});

function loadDirectUrl(url) {
    if (currentTorrent) {
        webtorrentClient.remove(currentTorrent.infoHash);
        currentTorrent = null;
    }

    // Hide placeholder and show custom video controls
    videoPlaceholder.classList.add('hidden');
    document.getElementById('custom-controls').classList.remove('hidden');

    let video = document.querySelector('video');
    if (!video) {
        video = document.createElement('video');
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.backgroundColor = '#000';
        video.playsInline = true;
        document.getElementById('video-container').appendChild(video);
    }

    video.removeAttribute('id');
    video.autoplay = false;
    // CRITICAL FIX: Do NOT use preload="auto" for proxy streams, it forces browsers (esp mobile) 
    // to aggressively spam the Node mapping with concurrent Range queries, causing lag loops.
    video.preload = 'metadata';

    video.onerror = () => {
        const err = video.error;
        if (err) {
            console.error(`Video Error ${err.code}: ${err.message}`);
            addSystemMessage(`Browser cannot decode video: ${err.message || 'Codec not supported'}`);
        }
    };

    // Cache-bust the URL so peers don't get stuck on stale browser chunks
    // However, do NOT apply cache-busting to native blob: URLs which breaks local streaming
    let safeUrl = url;
    if (!url.startsWith('blob:')) {
        safeUrl = url.includes('?') ? `${url}&t=${Date.now()}` : `${url}?t=${Date.now()}`;
    }

    video.src = safeUrl;
    video.load();

    addSystemMessage(`Streaming: HD Video Source`);

    if (isHost) {
        // Automatically attempt to play once sufficient data is loaded
        video.addEventListener('canplay', () => {
            video.play().catch(e => console.warn("Autoplay blocked:", e));
            playPauseIcon.className = 'fas fa-pause';
        }, { once: true });
    }

    initVideoListeners(video);
}


function loadTorrent(torrentId) {
    showBuffering("Finding peers...");
    if (currentTorrent) {
        webtorrentClient.remove(currentTorrent.infoHash);
    }

    // Always pass trackerOpts when loading torrents
    webtorrentClient.add(torrentId, trackerOpts, (torrent) => {
        // Force the discovery module to use the WebSocket trackers
        trackerOpts.announce.forEach(t => {
            if (!torrent.announce.includes(t)) {
                torrent.announce.push(t);
            }
        });
        if (torrent.discovery && torrent.discovery.setAnnounce) {
            torrent.discovery.setAnnounce(torrent.announce);
        }

        onTorrentReady(torrent);
    });
}

function onTorrentReady(torrent) {
    currentTorrent = torrent;
    videoPlaceholder.classList.add('hidden');

    // Find highest quality playable video file
    const videoFile = torrent.files.find(file => {
        return file.name.endsWith('.mp4') ||
            file.name.endsWith('.webm') ||
            file.name.endsWith('.ogg') ||
            file.name.endsWith('.mkv');
    }) || torrent.files[0];

    addSystemMessage(`Streaming: ${videoFile.name}`);

    // Render to player
    videoFile.renderTo('video', { autoplay: false, muted: false }, (err, elem) => {
        if (err) return console.error(err);
        const video = document.querySelector('video');

        // Auto remove ID so WebTorrent doesn't replace it unexpectedly on subsequent loads
        if (video) video.removeAttribute('id');

        initVideoListeners(video);
    });

    torrent.on('download', () => {
        peerCountDisplay.textContent = torrent.numPeers;
        // Update buffer UI if we are buffering
        if (!document.getElementById('buffering-spinner').classList.contains('hidden')) {
            bufferText.textContent = `Buffering... ${(torrent.progress * 100).toFixed(1)}%`;
        }
    });

    torrent.on('wire', () => {
        peerCountDisplay.textContent = torrent.numPeers;
    });
}

// ----------------------------------------------------
// 4. Video Synchronization Logic
// ----------------------------------------------------

function initVideoListeners(video) {
    hideBuffering();

    // ----- Host Outbound Events -----
    video.addEventListener('play', () => {
        playPauseIcon.className = 'fas fa-pause';
        if (isHost && !ignoreSyncEvents) {
            socket.emit('sync-action', { type: 'play', time: video.currentTime });
        }
    });

    video.addEventListener('pause', () => {
        playPauseIcon.className = 'fas fa-play';
        if (isHost && !ignoreSyncEvents) {
            socket.emit('sync-action', { type: 'pause', time: video.currentTime });
        }
    });

    video.addEventListener('seeked', () => {
        if (isHost && !ignoreSyncEvents) {
            socket.emit('sync-action', { type: 'seek', time: video.currentTime });
        }
    });

    video.addEventListener('timeupdate', () => {
        updateCustomControls(video);
    });

    video.addEventListener('waiting', () => {
        if (isHost) return; // Host has the file locally usually, but if magnet, show it
        showBuffering("Buffering chunk...");
    });

    video.addEventListener('playing', () => {
        hideBuffering();
    });

    // Host sends periodic time syncs (Every 3 seconds)
    setInterval(() => {
        if (isHost && !video.paused) {
            socket.emit('sync-action', { type: 'timeupdate', time: video.currentTime });
        }
    }, 3000);

    // ----- Inbound Sync Events (Peers adjust to Host) -----
    socket.off('sync-action'); // Clear old listeners
    socket.on('sync-action', (data) => {
        if (isHost) return; // Prevent loop

        if (data.type === 'play') {
            ignoreSyncEvents = true;
            video.currentTime = data.time;
            video.play().catch(e => console.log("Autoplay prevented"));
            setTimeout(() => ignoreSyncEvents = false, 100);
        }
        else if (data.type === 'pause') {
            ignoreSyncEvents = true;
            video.currentTime = data.time;
            video.pause();
            setTimeout(() => ignoreSyncEvents = false, 100);
        }
        else if (data.type === 'seek') {
            ignoreSyncEvents = true;
            video.currentTime = data.time;
            setTimeout(() => ignoreSyncEvents = false, 100);
        }
        else if (data.type === 'timeupdate') {
            // Auto-correction system
            const timeDiff = Math.abs(video.currentTime - data.time);
            if (timeDiff > 0.5) {
                ignoreSyncEvents = true;
                video.currentTime = data.time;
                if (video.paused) video.play().catch(e => { });
                setTimeout(() => ignoreSyncEvents = false, 100);
            }
        }
    });

    // ----- Custom UI Interaction (Host Only) -----
    playPauseBtn.onclick = () => {
        if (video.paused) video.play();
        else video.pause();
    };

    progressBar.addEventListener('input', (e) => {
        const time = (e.target.value / 100) * video.duration;
        video.currentTime = time;
    });

    fullscreenBtn.onclick = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            document.getElementById('video-container').requestFullscreen();
        }
    };

    // ----- Audio Controls -----
    volumeSlider.addEventListener('input', (e) => {
        video.volume = e.target.value;
        video.muted = false;
        muteBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
        if (video.volume === 0) {
            muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
        }
    });

    muteBtn.onclick = () => {
        video.muted = !video.muted;
        if (video.muted) {
            muteBtn.innerHTML = '<i class="fas fa-volume-mute"></i>';
            volumeSlider.value = 0;
        } else {
            muteBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
            volumeSlider.value = video.volume || 1;
            if (video.volume === 0) {
                video.volume = 0.5;
                volumeSlider.value = 0.5;
            }
        }
    };
}

function updateCustomControls(video) {
    if (video.duration) {
        const progress = (video.currentTime / video.duration) * 100;
        progressBar.value = progress;
        currentTimeEl.textContent = formatTime(video.currentTime);
        durationEl.textContent = formatTime(video.duration);
    }
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ----------------------------------------------------
// 5. Scroll Animations
// ----------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
            }
        });
    }, { threshold: 0.1 });

    document.querySelectorAll('.fade-in-scroll').forEach((el) => {
        observer.observe(el);
    });
});

function showBuffering(msg) {
    bufferingSpinner.classList.remove('hidden');
    bufferText.textContent = msg;
}
function hideBuffering() {
    bufferingSpinner.classList.add('hidden');
}


// ----------------------------------------------------
// 5. Chat & Sidebar Navigation
// ----------------------------------------------------

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    });
});

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) {
        socket.emit('chat-message', text);
        chatInput.value = '';
    }
});

socket.on('chat-message', (data) => {
    if (data.isSystem) {
        addSystemMessage(data.text);
        return;
    }
    const msgEl = document.createElement('div');
    msgEl.className = 'message';

    let hostBadge = data.isHost ? '<span class="host-badge">HOST</span>' : '';
    msgEl.innerHTML = `<span class="author">${data.username}</span>${hostBadge} <span class="text">${data.text}</span>`;

    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

function addSystemMessage(text) {
    const msgEl = document.createElement('div');
    msgEl.className = 'message system-msg';
    msgEl.textContent = text;
    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
