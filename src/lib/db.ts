/**
 * Base de datos LOCAL en archivo JSON (./data/db.json).
 *
 * No usamos servicios externos. Guardamos estado de proyectos, jobs y logs.
 * Persistencia sincronica: como Node corre single-thread y nuestras escrituras
 * son sync, no hay races dentro del proceso. Se usa un singleton via globalThis
 * para sobrevivir al HMR de Next en dev.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { JobRecord, LogEntry, ProjectRecord } from "./types";

interface DbShape {
  projects: Record<string, ProjectRecord>;
  jobs: Record<string, JobRecord>;
  logs: Record<string, LogEntry[]>;
}

const DB_FILE = path.join(config.storage.dataDir, "db.json");

function emptyDb(): DbShape {
  return { projects: {}, jobs: {}, logs: {} };
}

function load(): DbShape {
  try {
    fs.mkdirSync(config.storage.dataDir, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      return emptyDb();
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      projects: parsed.projects ?? {},
      jobs: parsed.jobs ?? {},
      logs: parsed.logs ?? {},
    };
  } catch (err) {
    console.error("[db] No se pudo leer db.json, arrancando vacio:", err);
    return emptyDb();
  }
}

function persist(db: DbShape): void {
  fs.mkdirSync(config.storage.dataDir, { recursive: true });
  // Escritura atomica: tmp + rename.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

// Singleton resiliente al HMR.
const globalForDb = globalThis as unknown as { __augcDb?: DbShape };
const db: DbShape = globalForDb.__augcDb ?? (globalForDb.__augcDb = load());

function save(): void {
  persist(db);
}

/* ----------------------------- Proyectos ----------------------------- */

export const projectsDb = {
  list(): ProjectRecord[] {
    return Object.values(db.projects).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  },
  get(id: string): ProjectRecord | undefined {
    return db.projects[id];
  },
  upsert(record: ProjectRecord): ProjectRecord {
    db.projects[record.id] = record;
    save();
    return record;
  },
  update(id: string, patch: Partial<ProjectRecord>): ProjectRecord | undefined {
    const existing = db.projects[id];
    if (!existing) return undefined;
    const updated: ProjectRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    db.projects[id] = updated;
    save();
    return updated;
  },
  remove(id: string): void {
    delete db.projects[id];
    for (const jobId of Object.keys(db.jobs)) {
      if (db.jobs[jobId].projectId === id) delete db.jobs[jobId];
    }
    delete db.logs[id];
    save();
  },
};

/* ------------------------------- Jobs -------------------------------- */

export const jobsDb = {
  get(id: string): JobRecord | undefined {
    return db.jobs[id];
  },
  byProject(projectId: string): JobRecord[] {
    return Object.values(db.jobs)
      .filter((j) => j.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  /** Busca el job de imagen de un projecto por el id de imagen. */
  imageJob(projectId: string, imageId: string): JobRecord | undefined {
    return Object.values(db.jobs).find(
      (j) => j.projectId === projectId && j.type === "image" && j.refId === imageId
    );
  },
  upsert(record: JobRecord): JobRecord {
    db.jobs[record.id] = record;
    save();
    return record;
  },
  upsertMany(records: JobRecord[]): void {
    for (const r of records) db.jobs[r.id] = r;
    save();
  },
  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const existing = db.jobs[id];
    if (!existing) return undefined;
    const updated: JobRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    db.jobs[id] = updated;
    save();
    return updated;
  },
  removeByProject(projectId: string): void {
    for (const id of Object.keys(db.jobs)) {
      if (db.jobs[id].projectId === projectId) delete db.jobs[id];
    }
    save();
  },
};

/* ------------------------------- Logs -------------------------------- */

export const logsDb = {
  byProject(projectId: string): LogEntry[] {
    return db.logs[projectId] ?? [];
  },
  append(projectId: string, entry: LogEntry): void {
    const list = db.logs[projectId] ?? [];
    list.push(entry);
    // Recortamos al maximo configurado (conservamos las mas nuevas).
    const max = config.pipeline.maxLogEntries;
    db.logs[projectId] = list.length > max ? list.slice(list.length - max) : list;
    save();
  },
  clear(projectId: string): void {
    delete db.logs[projectId];
    save();
  },
};
