import Database from "better-sqlite3";

export type SessionRow = {
  id: string;
  agent: string;
  status: string;
  started_at: string;
  last_activity_at: string | null;
  completed_at: string | null;
  turns: number;
  cost_usd: number;
  result_subtype: string | null;
  prompt_summary: string | null;
};

export type EscalationRow = {
  id: number;
  created_at: string;
  agent: string;
  session_id: string | null;
  action_type: string;
  action_detail: string;
  agent_context: string | null;
  priority: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
};

export type HealthLogRow = {
  id: number;
  timestamp: string;
  agent: string;
  event: string;
  detail: string | null;
};

export type PermissionLogRow = {
  id: number;
  timestamp: string;
  agent: string;
  tool: string;
  input_summary: string | null;
  tier: number;
  decision: string;
  decided_by: string | null;
};

export type MessageRow = {
  id: number;
  created_at: string;
  sender: string;
  recipient: string;
  type: string;
  content: string;
  status: string;
  response: string | null;
  responded_at: string | null;
};

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_activity_at TEXT,
        completed_at TEXT,
        turns INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0.0,
        result_subtype TEXT,
        prompt_summary TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now')),
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        response TEXT,
        responded_at TEXT
      );

      CREATE TABLE IF NOT EXISTS escalations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now')),
        agent TEXT NOT NULL,
        session_id TEXT,
        action_type TEXT NOT NULL,
        action_detail TEXT NOT NULL,
        agent_context TEXT,
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'pending',
        resolved_at TEXT,
        resolved_by TEXT,
        resolution_note TEXT
      );

      CREATE TABLE IF NOT EXISTS health_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        agent TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT
      );

      CREATE TABLE IF NOT EXISTS permission_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT (datetime('now')),
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_summary TEXT,
        tier INTEGER NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT
      );
    `);
  }

  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  insertSession(params: { id: string; agent: string; status: string; promptSummary: string }) {
    this.db
      .prepare("INSERT INTO sessions (id, agent, status, prompt_summary) VALUES (?, ?, ?, ?)")
      .run(params.id, params.agent, params.status, params.promptSummary);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  updateSession(
    id: string,
    updates: { status?: string; turns?: number; costUsd?: number; resultSubtype?: string }
  ) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (updates.status !== undefined) {
      sets.push("status = ?");
      vals.push(updates.status);
      if (updates.status === "completed" || updates.status === "failed") {
        sets.push("completed_at = datetime('now')");
      }
    }
    if (updates.turns !== undefined) {
      sets.push("turns = ?");
      vals.push(updates.turns);
    }
    if (updates.costUsd !== undefined) {
      sets.push("cost_usd = ?");
      vals.push(updates.costUsd);
    }
    if (updates.resultSubtype !== undefined) {
      sets.push("result_subtype = ?");
      vals.push(updates.resultSubtype);
    }
    sets.push("last_activity_at = datetime('now')");
    vals.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }

  getActiveSessions(): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC")
      .all() as SessionRow[];
  }

  insertEscalation(params: {
    agent: string;
    sessionId: string | null;
    actionType: string;
    actionDetail: string;
    agentContext: string | null;
    priority?: string;
  }) {
    this.db
      .prepare(
        `INSERT INTO escalations (agent, session_id, action_type, action_detail, agent_context, priority)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        params.agent,
        params.sessionId,
        params.actionType,
        params.actionDetail,
        params.agentContext,
        params.priority ?? "normal"
      );
  }

  getPendingEscalations(): EscalationRow[] {
    return this.db
      .prepare("SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as EscalationRow[];
  }

  getEscalationById(id: number): EscalationRow | null {
    return (this.db
      .prepare("SELECT * FROM escalations WHERE id = ?")
      .get(id) as EscalationRow) ?? null;
  }

  resolveEscalation(
    id: number,
    status: "approved" | "denied" | "expired",
    resolvedBy: string,
    note?: string
  ) {
    this.db
      .prepare(
        `UPDATE escalations SET status = ?, resolved_at = datetime('now'), resolved_by = ?, resolution_note = ?
         WHERE id = ?`
      )
      .run(status, resolvedBy, note ?? null, id);
  }

  clearPendingEscalations(): number {
    const result = this.db
      .prepare("UPDATE escalations SET status = 'denied', resolved_at = datetime('now'), resolved_by = 'ian', resolution_note = 'queue cleared' WHERE status = 'pending'")
      .run();
    return result.changes;
  }

  logHealthEvent(agent: string, event: string, detail?: string) {
    this.db
      .prepare("INSERT INTO health_log (agent, event, detail) VALUES (?, ?, ?)")
      .run(agent, event, detail ?? null);
  }

  getHealthLog(agent: string, limit: number): HealthLogRow[] {
    return this.db
      .prepare("SELECT * FROM health_log WHERE agent = ? ORDER BY timestamp DESC LIMIT ?")
      .all(agent, limit) as HealthLogRow[];
  }

  logPermission(
    agent: string,
    tool: string,
    inputSummary: string | null,
    tier: number,
    decision: string,
    decidedBy: string
  ) {
    this.db
      .prepare(
        `INSERT INTO permission_log (agent, tool, input_summary, tier, decision, decided_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(agent, tool, inputSummary, tier, decision, decidedBy);
  }

  getPermissionLog(agent: string, limit: number): PermissionLogRow[] {
    return this.db
      .prepare("SELECT * FROM permission_log WHERE agent = ? ORDER BY timestamp DESC LIMIT ?")
      .all(agent, limit) as PermissionLogRow[];
  }

  insertMessage(params: { sender: string; recipient: string; type: string; content: string }) {
    this.db
      .prepare("INSERT INTO messages (sender, recipient, type, content) VALUES (?, ?, ?, ?)")
      .run(params.sender, params.recipient, params.type, params.content);
  }

  getPendingMessages(recipient: string): MessageRow[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE recipient = ? AND status = 'pending' ORDER BY created_at ASC"
      )
      .all(recipient) as MessageRow[];
  }

  markMessageDelivered(id: number) {
    this.db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(id);
  }

  markMessageResponded(id: number, response: string) {
    this.db
      .prepare(
        "UPDATE messages SET status = 'responded', response = ?, responded_at = datetime('now') WHERE id = ?"
      )
      .run(response, id);
  }

  close() {
    this.db.close();
  }
}
