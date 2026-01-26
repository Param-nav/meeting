import express from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";

/* ---------------- CONFIG ---------------- */
const PORT = process.env.PORT || 10000;
const app = express();

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ---------------- HTTP + SOCKET ---------------- */
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket"],
  pingInterval: 25000,
  pingTimeout: 60000,
});

/* ---------------- IN-MEMORY STORE ---------------- */
// users: [{ username, password, displayName, gender, country }]
// rooms[meetingId] = { hostId, hostName, users: Map<socketId, username> }
const users = [];
const rooms = {};

/* ---------------- HELPERS ---------------- */
const getRoomsList = () =>
  Object.keys(rooms).map((meetingId) => ({
    meetingId,
    host: rooms[meetingId].hostName,
    participants: rooms[meetingId].users.size,
  }));

/* ---------------- AUTH ---------------- */
app.post("/signup", async (req, res) => {
  const { username, password, displayName, gender, country } = req.body;

  if (!username || !password) {
    return res.status(400).json({ msg: "Missing fields" });
  }

  if (users.find((u) => u.username === username)) {
    return res.status(400).json({ msg: "User exists" });
  }

  const hash = await bcrypt.hash(password, 10);

  users.push({ username, password: hash, displayName, gender, country });
  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users.find((u) => u.username === username);

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ msg: "Invalid credentials" });
  }

  res.json({
    success: true,
    user: {
      username: user.username,
      displayName: user.displayName,
      gender: user.gender,
      country: user.country,
    },
  });
});

/* ---------------- SOCKET ---------------- */
io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);

  /* -------- LOBBY -------- */

  socket.on("get-rooms", () => {
    socket.emit("rooms-update", getRoomsList());
  });

  socket.on("create-room", ({ meetingId, host }) => {
    if (!meetingId || rooms[meetingId]) return;

    rooms[meetingId] = {
      hostId: socket.id,
      hostName: host || "Host",
      users: new Map(),
    };

    console.log("🆕 Room created:", meetingId);

    io.emit("room-created", {
      meetingId,
      host: host || "Host",
      participants: 0,
    });

    io.emit("rooms-update", getRoomsList());
  });

  /* -------- JOIN MEETING -------- */

  socket.on("join-meeting", ({ meetingId, username }) => {
    if (!meetingId) return;

    if (!rooms[meetingId]) {
      rooms[meetingId] = {
        hostId: socket.id,
        hostName: username || "Host",
        users: new Map(),
      };
    }

    const room = rooms[meetingId];
    room.users.set(socket.id, username || "Guest");

    socket.join(meetingId);
    socket.meetingId = meetingId;
    socket.username = username || "Guest";

    const existingUsers = [...room.users.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ peerId: id, username: name }));

    socket.emit("existing-users", existingUsers);

    socket.to(meetingId).emit("user-joined", {
      peerId: socket.id,
      username: socket.username,
    });

    io.emit("rooms-update", getRoomsList());

    console.log(`👤 ${socket.username} joined ${meetingId}`);
  });

  /* -------- WEBRTC SIGNALING -------- */

  socket.on("offer", ({ to, offer }) => {
    io.to(to).emit("offer", { from: socket.id, offer });
  });

  socket.on("answer", ({ to, answer }) => {
    io.to(to).emit("answer", { from: socket.id, answer });
  });

  socket.on("ice-candidate", ({ to, candidate, sdpMid, sdpMLineIndex }) => {
    io.to(to).emit("ice-candidate", {
      from: socket.id,
      candidate,
      sdpMid,
      sdpMLineIndex,
    });
  });

  /* -------- DISCONNECT -------- */

  socket.on("disconnect", () => {
    const meetingId = socket.meetingId;
    if (!meetingId || !rooms[meetingId]) return;

    const room = rooms[meetingId];
    room.users.delete(socket.id);

    socket.to(meetingId).emit("user-left", socket.id);

    if (socket.id === room.hostId) {
      delete rooms[meetingId];
      io.emit("room-removed", meetingId);
      io.emit("rooms-update", getRoomsList());
      console.log("🛑 Room closed:", meetingId);
      return;
    }

    if (room.users.size === 0) {
      delete rooms[meetingId];
      io.emit("room-removed", meetingId);
    }

    io.emit("rooms-update", getRoomsList());
  });
});

/* ---------------- HEALTH / WAKE-UP ---------------- */
app.get("/", (_, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({ success: true, message: "Server awake" });
});

/* ---------------- START ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
