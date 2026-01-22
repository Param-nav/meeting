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
// rooms[meetingId] = { hostId, users: Map<socketId, username> }
const users = [];
const rooms = {};

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

  socket.on("join-meeting", ({ meetingId, username }) => {
    if (!meetingId) return;

    if (!rooms[meetingId]) {
      rooms[meetingId] = {
        hostId: socket.id,
        users: new Map(),
      };
    }

    const room = rooms[meetingId];
    room.users.set(socket.id, username || "Guest");

    socket.join(meetingId);
    socket.meetingId = meetingId;
    socket.username = username || "Guest";

    // Send existing users to new joiner
    const existingUsers = [...room.users.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({
        peerId: id,
        username: name,
      }));

    socket.emit("existing-users", existingUsers);

    // Notify others
    socket.to(meetingId).emit("user-joined", {
      peerId: socket.id,
      username: socket.username,
    });

    console.log(`👤 ${socket.username} joined ${meetingId}`);
  });

  /* -------- SIGNALING -------- */
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

    // End meeting if host left
    if (socket.id === room.hostId) {
      socket.to(meetingId).emit("meeting-ended");
      delete rooms[meetingId];
      console.log("🛑 Meeting ended:", meetingId);
      return;
    }

    // Cleanup empty rooms
    if (room.users.size === 0) {
      delete rooms[meetingId];
    }
  });
});

/* ---------------- HEALTH ---------------- */
app.get("/", (_, res) => {
  res.send("✅ Zoom-like signaling server running");
});

/* ---------------- START ---------------- */
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
