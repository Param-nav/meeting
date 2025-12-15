// server.js
import express from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

/* ---------------- CONFIG ---------------- */
const PORT = process.env.PORT || 10000;
const app = express();

/* ---------------- MIDDLEWARE ---------------- */
app.use(cors({ origin: "*" }));
app.use(express.json());

/* ---------------- HTTP + SOCKET SERVER ---------------- */
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },

  // 🔥 VERY IMPORTANT FOR RENDER / FREE HOSTS
  transports: ["websocket"],

  // 🔥 KEEP CONNECTION ALIVE
  pingInterval: 25000,
  pingTimeout: 60000,
});

/* ---------------- IN-MEMORY STORAGE ---------------- */
// ⚠️ Demo only — resets on restart
const users = [];
const rooms = {}; 
// rooms[meetingId] = { hostId, users: Map<socketId, username> }

/* ---------------- AUTH ROUTES ---------------- */
app.post("/signup", async (req, res) => {
  const { username, password, displayName, gender, country } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, msg: "Missing fields" });
  }

  if (users.find((u) => u.username === username)) {
    return res.status(400).json({ success: false, msg: "User already exists" });
  }

  const hash = await bcrypt.hash(password, 10);

  users.push({
    username,
    password: hash,
    displayName,
    gender,
    country,
  });

  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(400).json({ success: false, msg: "User not found" });
  }

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return res.status(400).json({ success: false, msg: "Wrong password" });
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

/* ---------------- SOCKET.IO ---------------- */
io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);

  /* -------- CREATE MEETING -------- */
  socket.on("create-meeting", ({ username }) => {
    const meetingId = uuidv4();

    rooms[meetingId] = {
      hostId: socket.id,
      users: new Map([[socket.id, username || "Host"]]),
    };

    socket.join(meetingId);
    socket.meetingId = meetingId;
    socket.username = username || "Host";

    socket.emit("meeting-created", meetingId);

    console.log("🆕 Meeting created:", meetingId);
  });

  /* -------- JOIN MEETING -------- */
  socket.on("join-meeting", ({ meetingId, username }) => {
    const room = rooms[meetingId];

    if (!room) {
      socket.emit("meeting-error", "Meeting not found");
      return;
    }

    room.users.set(socket.id, username);
    socket.join(meetingId);

    socket.meetingId = meetingId;
    socket.username = username;

    // Send existing users to new joiner
    const existingUsers = [...room.users.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({
        id,
        username: name,
      }));

    socket.emit("existing-users", existingUsers);

    // Notify others
    socket.to(meetingId).emit("user-joined", {
      id: socket.id,
      username,
    });

    console.log("👤 Joined:", username, meetingId);
  });

  /* -------- WEBRTC SIGNALING -------- */
  socket.on("offer", ({ to, offer }) => {
    io.to(to).emit("offer", {
      from: socket.id,
      offer,
    });
  });

  socket.on("answer", ({ to, answer }) => {
    io.to(to).emit("answer", {
      from: socket.id,
      answer,
    });
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
  socket.on("disconnect", (reason) => {
    console.log("⚠️ Disconnected:", socket.id, "Reason:", reason);

    const meetingId = socket.meetingId;
    if (!meetingId || !rooms[meetingId]) return;

    const room = rooms[meetingId];
    room.users.delete(socket.id);

    socket.to(meetingId).emit("user-left", {
      id: socket.id,
    });

    // If host leaves → end meeting
    if (socket.id === room.hostId) {
      socket.to(meetingId).emit("meeting-ended");
      delete rooms[meetingId];
      console.log("🛑 Meeting ended:", meetingId);
    }
  });
});

/* ---------------- HEALTH CHECK ---------------- */
app.get("/", (_, res) => {
  res.send("✅ Signaling server running");
});

/* ---------------- START SERVER ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
