/**
 * What CodeArena remembers between launches.
 *
 * Only preferences live here — which projects you have opened, and which one you were last
 * in. No credentials, ever: the agent binaries own their own credential stores, and this file
 * exists partly to keep it obvious that nothing sensitive is being written alongside them.
 *
 * A corrupt or unreadable store is treated as an empty one. Losing your recent-projects list
 * is not worth failing to start over.
 */
import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";

export interface RecentProject {
  dir: string;
  /** Epoch millis, for ordering. */
  openedAt: number;
}

interface StoreShape {
  recents: RecentProject[];
}

const MAX_RECENTS = 8;

function file(): string {
  return path.join(app.getPath("userData"), "codearena.json");
}

async function read(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(file(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    const recents = Array.isArray(parsed.recents) ? parsed.recents : [];
    return {
      recents: recents.filter(
        (r): r is RecentProject => typeof r?.dir === "string" && typeof r?.openedAt === "number",
      ),
    };
  } catch {
    return { recents: [] };
  }
}

async function write(store: StoreShape): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), JSON.stringify(store, null, 2), "utf8");
  } catch {
    // A project list that fails to save is a worse day, not a broken one.
  }
}

async function stillThere(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Recent projects, newest first, with anything since deleted or moved dropped. */
export async function recents(): Promise<string[]> {
  const store = await read();
  const alive: RecentProject[] = [];
  for (const entry of store.recents) {
    if (await stillThere(entry.dir)) alive.push(entry);
  }
  if (alive.length !== store.recents.length) await write({ recents: alive });
  return alive.sort((a, b) => b.openedAt - a.openedAt).map((r) => r.dir);
}

/** The project to open on launch, or null on a first run. */
export async function lastProject(): Promise<string | null> {
  return (await recents())[0] ?? null;
}

/** Record a project as most-recently used. */
export async function remember(dir: string): Promise<void> {
  const store = await read();
  const others = store.recents.filter((r) => r.dir !== dir);
  await write({
    recents: [{ dir, openedAt: Date.now() }, ...others].slice(0, MAX_RECENTS),
  });
}

/** Drop a project from the list without touching anything on disk. */
export async function forget(dir: string): Promise<void> {
  const store = await read();
  await write({ recents: store.recents.filter((r) => r.dir !== dir) });
}
