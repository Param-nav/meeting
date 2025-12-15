// server.js 
import express from "express";
import http from "http";
import cors from "cors";
import bcrypt from "bcryptjs";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

const PORT = process.env.PORT || 5000; // Render assigns port dynamically
const app = express();

// ---------------- MIDDLEWARE ----------------
const corsOptions = {
  origin: "*", // Allow all origins for testing; restrict in production
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.use(express.json());

// Handle OPTIONS preflight requests
app.options("*", cors(corsOptions));

// ---------------- SERVER & SOCKET.IO ----------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"], // fallback to polling if websocket fails
});

// Optional: log connection errors
io.engine.on("connection_error", (err) => {
  console.log("⚠️ Connection error:", err);
});

// ---------------- IN-MEMORY DATA ----------------
const users = []; // user database (demo only)
const rooms = {}; // meetingId -> { hostId, users: Map }

// ---------------- AUTH ROUTES ----------------
app.post("/signup", async (req, res) => {
  const { username, password, name, gender, country } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, msg: "Missing fields" });

  if (users.find((u) => u.username === username))
    return res.status(400).json({ success: false, msg: "User exists" });

  const hash = await bcrypt.hash(password, 10);
  users.push({ username, password: hash, name, gender, country });

  res.json({ success: true });
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = users.find((u) => u.username === username);
  if (!user) return res.status(400).json({ success: false, msg: "User not found" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ success: false, msg: "Wrong password" });

  res.json({ success: true, user: { username, name: user.name } });
});

// ---------------- SOCKET.IO EVENTS ----------------
io.on("connection", (socket) => {
  console.log("⚡ Connected:", socket.id);

  // Create a meeting (host)
  socket.on("create-meeting", ({ username }, cb) => {
    const meetingId = uuidv4();
    rooms[meetingId] = {
      hostId: socket.id,
      users: new Map([[socket.id, username]]),
    };
    socket.join(meetingId);
    socket.meetingId = meetingId;
    socket.username = username;
    console.log("🆕 Meeting created:", meetingId);
    cb({ meetingId });
  });

  // Join a meeting (participant)
  socket.on("join-meeting", ({ meetingId, username }, cb) => {
    const room = rooms[meetingId];
    if (!room) return cb({ error: "Meeting not found" });

    room.users.set(socket.id, username);
    socket.join(meetingId);
    socket.meetingId = meetingId;
    socket.username = username;

    const existingUsers = [...room.users.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, name]) => ({ peerId: id, username: name }));

    socket.emit("existing-users", existingUsers);
    socket.to(meetingId).emit("user-joined", { peerId: socket.id, username });

    cb({ success: true });
  });

  // SIGNALING EVENTS
  socket.on("offer", ({ to, sdp }) => io.to(to).emit("offer", { from: socket.id, sdp }));
  socket.on("answer", ({ to, sdp }) => io.to(to).emit("answer", { from: socket.id, sdp }));
  socket.on("ice-candidate", ({ to, candidate }) =>
    io.to(to).emit("ice-candidate", { from: socket.id, candidate })
  );

  // DISCONNECT
  socket.on("disconnect", () => {
    const meetingId = socket.meetingId;
    if (!meetingId || !rooms[meetingId]) return;

    const room = rooms[meetingId];
    room.users.delete(socket.id);
    socket.to(meetingId).emit("user-left", socket.id);

    // host left → end meeting
    if (socket.id === room.hostId) {
      socket.to(meetingId).emit("meeting-ended");
      delete rooms[meetingId];
      console.log("🛑 Meeting ended:", meetingId);
    }
  });
});

// ---------------- ROOT ----------------
app.get("/", (_, res) => res.send("✅ Zoom-style signaling server running"));

// ---------------- START SERVER ----------------
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
