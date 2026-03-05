const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100 MB max limit for chunk payloads
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve frontend files
app.use(express.static(path.join(__dirname, '../public')));

const pendingRequests = {};
let requestCounter = 0;

// Serve native video streams by Proxying HTTP Range requests to the Host's WebSocket
app.get('/stream/:roomId/:filename', (req, res) => {
  const roomId = req.params.roomId;
  const room = rooms[roomId];

  if (!room || !room.hostedFile) {
    return res.status(404).send('File not found or Host disconnected.');
  }

  const { size, type } = room.hostedFile;
  const range = req.headers.range;

  if (!range) {
    const head = {
      'Content-Length': size,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
    };
    res.writeHead(200, head);
    return res.end();
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const MAX_CHUNK = 1 * 1024 * 1024; // 1MB chunks to drastically reduce WebSocket routing latency on mobile

  let end = parts[1] ? parseInt(parts[1], 10) : size - 1;
  if (end >= size) end = size - 1;
  if (end - start > MAX_CHUNK) end = start + MAX_CHUNK;

  const chunksize = (end - start) + 1;

  const head = {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunksize,
    'Content-Type': type,
  };

  res.writeHead(206, head);

  const reqId = ++requestCounter;
  pendingRequests[reqId] = {
    res,
    timeout: setTimeout(() => {
      if (pendingRequests[reqId]) {
        res.end(); // Fail gracefully if Host times out
        delete pendingRequests[reqId];
      }
    }, 15000)
  };

  // Ask the host to send this exact byte slice
  io.to(room.host).emit('request-chunk', { reqId, start, end });
});

// In-memory state for rooms
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

  // Host registers a file without actually uploading it
  socket.on('host-file', (fileData) => {
    const roomId = getRoomId(socket);
    if (roomId && rooms[roomId].host === socket.id) {
      rooms[roomId].hostedFile = fileData;
      // Let everyone else in the room know the proxy URL
      const streamUrl = `/stream/${roomId}/${encodeURIComponent(fileData.name)}`;
      rooms[roomId].torrentId = streamUrl;
      socket.to(roomId).emit('new-torrent', streamUrl);
    }
  });

  // Host returns a requested binary chunk
  socket.on('chunk-response', ({ reqId, data }) => {
    const pending = pendingRequests[reqId];
    if (pending) {
      clearTimeout(pending.timeout);
      pending.res.end(data); // Write bytes seamlessly into the peer's HTTP stream
      delete pendingRequests[reqId];
    }
  });

  // Backward compatibility: explicit torrent set
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

          // Room empty, delete the room completely.
          // Because we don't store files natively anymore, there's no fs.unlink cleanup needed!
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
