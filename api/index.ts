import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@libsql/client";
import { createHmac, timingSafeEqual } from "crypto";

let db: ReturnType<typeof createClient>;
function getDb() {
  if (!db) {
    db = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return db;
}

let dbReady = false;
async function ensureDb() {
  if (dbReady) return;
  const db = getDb();
  await db.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS workouts (
        date_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brief TEXT DEFAULT '',
        exercises TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS completed_workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_key TEXT NOT NULL,
        name TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        total_time INTEGER NOT NULL,
        exercises TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      args: [],
    },
  ]);
  dbReady = true;
}

function getSessionToken(): string {
  const password = process.env.APP_PASSWORD!;
  return createHmac("sha256", password).update("authenticated").digest("hex");
}

function safeParse(s: unknown): unknown[] {
  if (!s || s === 'undefined' || s === 'null') return [];
  try { return JSON.parse(s as string); } catch { return []; }
}

function checkAuth(req: VercelRequest): boolean {
  const cookies = req.headers.cookie;
  if (!cookies) return false;
  const match = cookies.split(";").find((c) => c.trim().startsWith("session="));
  if (!match) return false;
  const token = match.split("=")[1]?.trim();
  if (!token) return false;
  const expected = getSessionToken();
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const base = req.headers.host ? `https://${req.headers.host}` : "https://localhost";
  const url = new URL(req.url || "/api", base);
  const path = url.pathname;

  try {
    // POST /api/login
    if (path === "/api/login" && req.method === "POST") {
      const { password } = req.body;
      const expected = process.env.APP_PASSWORD;
      if (!expected || !password || password !== expected) {
        return res.status(401).json({ error: "Invalid password" });
      }
      const token = getSessionToken();
      res.setHeader(
        "Set-Cookie",
        `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
      );
      return res.json({ ok: true });
    }

    // GET /api/auth
    if (path === "/api/auth" && req.method === "GET") {
      if (checkAuth(req)) {
        return res.json({ ok: true });
      }
      return res.status(401).json({ error: "Not authenticated" });
    }

    // All other routes require auth
    if (!checkAuth(req)) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    await ensureDb();

    // GET /api/workouts — list all scheduled workouts
    if (path === "/api/workouts" && req.method === "GET") {
      const result = await db.execute("SELECT * FROM workouts ORDER BY date_key DESC");
      const workouts = result.rows.map((row) => ({
        dateKey: row.date_key,
        name: row.name,
        brief: row.brief,
        blocks: safeParse(row.exercises),
      }));
      return res.json(workouts);
    }

    // POST /api/workouts — save a scheduled workout
    if (path === "/api/workouts" && req.method === "POST") {
      const { dateKey, name, brief, blocks } = req.body;
      if (!dateKey || !name || !blocks) {
        return res.status(400).json({ error: "dateKey, name, and blocks required" });
      }
      await db.execute({
        sql: `INSERT INTO workouts (date_key, name, brief, exercises) VALUES (?, ?, ?, ?)
              ON CONFLICT(date_key) DO UPDATE SET name=excluded.name, brief=excluded.brief, exercises=excluded.exercises`,
        args: [dateKey, name, brief || "", JSON.stringify(blocks)],
      });
      return res.json({ ok: true });
    }

    // GET /api/workouts/:dateKey
    const workoutMatch = path.match(/^\/api\/workouts\/(\d{4}-\d{2}-\d{2})$/);
    if (workoutMatch && req.method === "GET") {
      const dateKey = workoutMatch[1];
      const result = await db.execute({
        sql: "SELECT * FROM workouts WHERE date_key = ?",
        args: [dateKey],
      });
      if (result.rows.length === 0) {
        return res.json(null);
      }
      const row = result.rows[0];
      return res.json({
        dateKey: row.date_key,
        name: row.name,
        brief: row.brief,
        blocks: safeParse(row.exercises),
      });
    }

    // GET /api/completed — list all completed workouts
    if (path === "/api/completed" && req.method === "GET") {
      const result = await db.execute(
        "SELECT * FROM completed_workouts ORDER BY completed_at DESC"
      );
      const workouts = result.rows.map((row) => ({
        id: row.id,
        dateKey: row.date_key,
        name: row.name,
        completedAt: row.completed_at,
        totalTime: row.total_time,
        blocks: safeParse(row.exercises),
      }));
      return res.json(workouts);
    }

    // POST /api/completed — save a completed workout
    if (path === "/api/completed" && req.method === "POST") {
      const { dateKey, name, completedAt, totalTime, blocks } = req.body;
      if (!dateKey || !name || !completedAt || totalTime == null || !blocks) {
        return res
          .status(400)
          .json({ error: "dateKey, name, completedAt, totalTime, and blocks required" });
      }
      const result = await db.execute({
        sql: `INSERT INTO completed_workouts (date_key, name, completed_at, total_time, exercises)
              VALUES (?, ?, ?, ?, ?)`,
        args: [dateKey, name, completedAt, totalTime, JSON.stringify(blocks)],
      });
      return res.json({ ok: true, id: Number(result.lastInsertRowid) });
    }

    // GET /api/completed/:id
    const completedMatch = path.match(/^\/api\/completed\/(\d+)$/);
    if (completedMatch && req.method === "GET") {
      const id = parseInt(completedMatch[1]);
      const result = await db.execute({
        sql: "SELECT * FROM completed_workouts WHERE id = ?",
        args: [id],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      const row = result.rows[0];
      return res.json({
        id: row.id,
        dateKey: row.date_key,
        name: row.name,
        completedAt: row.completed_at,
        totalTime: row.total_time,
        blocks: safeParse(row.exercises),
      });
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error", details: String(err) });
  }
}
