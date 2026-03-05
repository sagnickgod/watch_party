const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR);
}

// Handle native file uploads from Host
app.post('/upload', (req, res) => {
  const filename = req.query.name;
  if (!filename) return res.status(400).send('No filename provided');

  const safeName = path.basename(filename);
  const filepath = path.join(UPLOADS_DIR, safeName);
  const writeStream = fs.createWriteStream(filepath);

  req.pipe(writeStream);

  req.on('end', () => {
    res.json({ success: true, url: `/stream/${encodeURIComponent(safeName)}` });
  });

  writeStream.on('error', (err) => {
    console.error("Upload stream error:", err);
    if (!res.headersSent) res.status(500).send('Upload Failed');
  });
});

// Serve native video streams with HTTP Range Support
app.get('/stream/:filename', (req, res) => {
  const filepath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }

  const stat = fs.statSync(filepath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const contentType = req.params.filename.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4';

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + fileSize);
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(filepath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    fs.createReadStream(filepath).pipe(res);
  }
});

// In-memory state for rooms
// rooms[roomId] = { host: socket.id, users: { socketId: { username, isHost } }, torrentId: null, state: { type, time, playing } }
const rooms = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User joins a room
  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);

    if (!rooms[roomId]) {
      // Room doesn't exist, this user becomes the host
      rooms[roomId] = {
        host: socket.id,
        users: {},
        torrentId: null,
        state: { type: 'pause', time: 0, playing: false }
      };
    }

    const room = rooms[roomId];
    const isHost = room.host === socket.id;
    room.users[socket.id] = { username, isHost };

    // Send the current room state back to the user joining
    socket.emit('room-joined', {
      roomId,
      isHost,
      torrentId: room.torrentId,
      users: room.users
    });

    // Notify others in the room
    socket.to(roomId).emit('user-joined', {
      socketId: socket.id,
      username,
      isHost
    });

    // Send updated user list to everyone
    io.to(roomId).emit('update-users', room.users);
  });

  // Host sets new torrent/magnet link
  socket.on('set-torrent', (torrentId) => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId].host === socket.id) {
      rooms[roomId].torrentId = torrentId;
      socket.to(roomId).emit('new-torrent', torrentId);
    }
  });

  // Sync Video Events (play, pause, seek, timeupdate)
  socket.on('sync-action', (data) => {
    const roomId = getRoomId(socket);
    // Only the host can broadcast sync events
    if (roomId && rooms[roomId].host === socket.id) {
      rooms[roomId].state = data; // store latest state
      socket.to(roomId).emit('sync-action', data);
    }
  });

  // Handle Chat messages
  socket.on('chat-message', (msg) => {
    const roomId = getRoomId(socket);
    if (roomId) {
      const user = rooms[roomId].users[socket.id];
      const username = user ? user.username : 'Anonymous';
      const isHost = rooms[roomId].host === socket.id;

      io.to(roomId).emit('chat-message', {
        username,
        text: msg,
        isHost
      });
    }
  });

  // Handle disconnection
  socket.on('disconnecting', () => {
    const roomId = getRoomId(socket);
    if (roomId) {
      const room = rooms[roomId];
      const user = room.users[socket.id];
      const username = user ? user.username : 'User';

      delete room.users[socket.id];
      socket.to(roomId).emit('user-left', { socketId: socket.id, username });

      // Host migration logic
      if (room.host === socket.id) {
        const remainingSockets = Object.keys(room.users);
        if (remainingSockets.length > 0) {
          // Assign new host randomly (or first available)
          const newHostId = remainingSockets[0];
          room.host = newHostId;
          room.users[newHostId].isHost = true;

          io.to(roomId).emit('new-host', newHostId);
          io.to(roomId).emit('chat-message', {
            username: 'System',
            text: `${room.users[newHostId].username} is the new host.`,
            isSystem: true
          });
          io.to(roomId).emit('update-users', room.users);
        } else {
          // Room empty, delete the room

          // Cleanup local server files if a stream URL was actively hosted
          if (room.torrentId && room.torrentId.startsWith('http')) {
            try {
              const urlObj = new URL(room.torrentId);
              const pathParts = urlObj.pathname.split('/');
              if (pathParts[1] === 'stream' && pathParts[2]) {
                const filenameToDel = decodeURIComponent(pathParts[2]);
                const filepath = path.join(UPLOADS_DIR, filenameToDel);
                if (fs.existsSync(filepath)) {
                  fs.unlink(filepath, (err) => {
                    if (err) console.error(`Failed to auto-delete ${filenameToDel}:`, err);
                    else console.log(`Auto-deleted room file: ${filenameToDel} to free space.`);
                  });
                }
              }
            } catch (e) {
              console.error("Error parsing URL for deletion cleanup", e);
            }
          }

          delete rooms[roomId];
        }
      } else {
        io.to(roomId).emit('update-users', room.users);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });

  // Helper to get user's active game room (excluding their own socket ID room)
  function getRoomId(sock) {
    return Array.from(sock.rooms).find(r => r !== sock.id);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Watch Party Server running on port ${PORT}`);
});
