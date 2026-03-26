require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Serve HTML files
app.use(express.static(path.join(__dirname)));

// ─── MONGOOSE SCHEMAS ─────────────────────────────────────
const roomSchema = new mongoose.Schema({
  roomId: { type: Number, required: true, unique: true },
  floor: Number,
  type: String,       // CO, SO, DC, SR
  status: { type: String, default: 'unassigned' },
  worker: { type: Number, default: null },
  priority: String,   // urgent, high, normal
  note: String,
  checklist: { type: [Boolean], default: [false,false,false,false,false,false,false,false] },
}, { timestamps: true });

const requestSchema = new mongoose.Schema({
  reqId: { type: Number, required: true, unique: true },
  room: Number,
  type: String,
  priority: String,
  time: String,
  worker: { type: Number, default: null },
  done: { type: Boolean, default: false },
  notes: String,
}, { timestamps: true });

const workerSchema = new mongoose.Schema({
  workerId: { type: Number, required: true, unique: true },
  name: String,
  initials: String,
  completed: { type: Number, default: 0 },
  onBreak: { type: Boolean, default: false },
  clockedIn: { type: Boolean, default: true },
}, { timestamps: true });

const Room = mongoose.model('Room', roomSchema);
const Request = mongoose.model('Request', requestSchema);
const Worker = mongoose.model('Worker', workerSchema);

// ─── ROUTES ───────────────────────────────────────────────

// Initialize / seed data (called by supervisor on startup)
app.post('/api/init', async (req, res) => {
  try {
    const { rooms, requests, workers } = req.body;

    // Clear existing and insert fresh
    await Room.deleteMany({});
    await Request.deleteMany({});
    await Worker.deleteMany({});

    if (rooms && rooms.length) {
      await Room.insertMany(rooms.map(r => ({
        roomId: r.id, floor: r.floor, type: r.type, status: r.status,
        worker: r.worker, priority: r.priority, note: r.note,
        checklist: r.checklist
      })));
    }

    if (requests && requests.length) {
      await Request.insertMany(requests.map(r => ({
        reqId: r.id, room: r.room, type: r.type, priority: r.priority,
        time: r.time, worker: r.worker, done: r.done, notes: r.notes
      })));
    }

    if (workers && workers.length) {
      await Worker.insertMany(workers.map(w => ({
        workerId: w.id, name: w.name, initials: w.initials,
        completed: w.completed || 0, onBreak: w.onBreak || false,
        clockedIn: w.clockedIn !== false
      })));
    }

    res.json({ ok: true, roomCount: rooms?.length || 0 });
  } catch (err) {
    console.error('Init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ROOMS ────────────────────────────────────────────────
app.get('/api/rooms', async (req, res) => {
  try {
    const filter = {};
    if (req.query.worker) filter.worker = parseInt(req.query.worker);
    const rooms = await Room.find(filter).sort({ roomId: 1 }).lean();
    res.json(rooms.map(r => ({
      id: r.roomId, floor: r.floor, type: r.type, status: r.status,
      worker: r.worker, priority: r.priority, note: r.note,
      checklist: r.checklist
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rooms/:id', async (req, res) => {
  try {
    const { status, checklist, worker } = req.body;
    const update = {};
    if (status !== undefined) update.status = status;
    if (checklist !== undefined) update.checklist = checklist;
    if (worker !== undefined) update.worker = worker;

    const room = await Room.findOneAndUpdate(
      { roomId: parseInt(req.params.id) },
      { $set: update },
      { new: true, lean: true }
    );
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ id: room.roomId, floor: room.floor, type: room.type, status: room.status,
      worker: room.worker, priority: room.priority, note: room.note, checklist: room.checklist });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk update rooms (for auto-assign, mark all complete, etc.)
app.put('/api/rooms', async (req, res) => {
  try {
    const { updates } = req.body; // [{ id, status, worker, checklist }, ...]
    if (!updates || !updates.length) return res.json({ ok: true, updated: 0 });

    const bulkOps = updates.map(u => ({
      updateOne: {
        filter: { roomId: u.id },
        update: { $set: { 
          ...(u.status !== undefined && { status: u.status }),
          ...(u.worker !== undefined && { worker: u.worker }),
          ...(u.checklist !== undefined && { checklist: u.checklist }),
        }}
      }
    }));

    const result = await Room.bulkWrite(bulkOps);
    res.json({ ok: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REQUESTS ─────────────────────────────────────────────
app.get('/api/requests', async (req, res) => {
  try {
    const reqs = await Request.find({}).sort({ reqId: 1 }).lean();
    res.json(reqs.map(r => ({
      id: r.reqId, room: r.room, type: r.type, priority: r.priority,
      time: r.time, worker: r.worker, done: r.done, notes: r.notes
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests', async (req, res) => {
  try {
    const { room, type, priority, time, worker, notes } = req.body;
    const reqId = Date.now();
    const newReq = await Request.create({ reqId, room, type, priority, time, worker, done: false, notes });
    res.json({ id: newReq.reqId, room: newReq.room, type: newReq.type, priority: newReq.priority,
      time: newReq.time, worker: newReq.worker, done: newReq.done, notes: newReq.notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/requests/:id', async (req, res) => {
  try {
    const update = {};
    if (req.body.done !== undefined) update.done = req.body.done;
    if (req.body.worker !== undefined) update.worker = req.body.worker;

    const r = await Request.findOneAndUpdate(
      { reqId: parseInt(req.params.id) },
      { $set: update },
      { new: true, lean: true }
    );
    if (!r) return res.status(404).json({ error: 'Request not found' });
    res.json({ id: r.reqId, room: r.room, type: r.type, priority: r.priority,
      time: r.time, worker: r.worker, done: r.done });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WORKERS ──────────────────────────────────────────────
app.get('/api/workers', async (req, res) => {
  try {
    const workers = await Worker.find({}).sort({ workerId: 1 }).lean();
    res.json(workers.map(w => ({
      id: w.workerId, name: w.name, initials: w.initials,
      completed: w.completed, onBreak: w.onBreak, clockedIn: w.clockedIn
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workers/:id', async (req, res) => {
  try {
    const update = {};
    if (req.body.onBreak !== undefined) update.onBreak = req.body.onBreak;
    if (req.body.clockedIn !== undefined) update.clockedIn = req.body.clockedIn;
    if (req.body.completed !== undefined) update.completed = req.body.completed;

    const w = await Worker.findOneAndUpdate(
      { workerId: parseInt(req.params.id) },
      { $set: update },
      { new: true, lean: true }
    );
    if (!w) return res.status(404).json({ error: 'Worker not found' });
    res.json({ id: w.workerId, name: w.name, initials: w.initials,
      completed: w.completed, onBreak: w.onBreak, clockedIn: w.clockedIn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONNECT & START ──────────────────────────────────────
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set in .env file!');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB Atlas');
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log(`📋 Supervisor: http://localhost:${PORT}/laquinta_housekeeping.html`);
      console.log(`👷 Worker:     http://localhost:${PORT}/worker_app.html`);
    });
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
