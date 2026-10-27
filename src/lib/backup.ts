import { chmod, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "fs/promises";
import { join } from "path";

/**
 * Pre-write page snapshots. Docmost's own page history cannot be relied on
 * to undo an API write (it may only snapshot after the change), so every
 * mutating tool saves the page's exact ProseMirror JSON here first and
 * aborts if that save fails.
 */
export interface PageSnapshot {
  pageId: string;
  title: string | null;
  spaceId: string;
  parentPageId: string | null;
  slugId?: string;
  icon?: string | null;
  operation: string;
  capturedAt: string;
  content: unknown;
}

export interface BackupEntry {
  file: string;
  capturedAt: string;
  operation: string;
}

const PAGE_ID = /^[0-9a-fA-F-]{8,64}$/;
// <stamp>_<operation>.json, e.g. 2026-10-27T10-15-30-123Z_replace.json
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-z-]+\.json$/;

export class BackupStore {
  constructor(
    private readonly dir: string | undefined,
    private readonly keepPerPage = 20,
    private readonly maxAgeDays = 90,
  ) {}

  private pageDir(pageId: string): string {
    if (!this.dir) {
      throw new Error(
        "Backups are not configured: set DOCMOST_BACKUP_DIR to a directory on a " +
          "persistent volume. Refusing to modify pages without a backup.",
      );
    }
    if (!PAGE_ID.test(pageId)) {
      throw new Error(`Refusing to back up page with unexpected id "${pageId}"`);
    }
    return join(this.dir, pageId);
  }

  /** Create (or tighten) the backup root and a page folder as owner-only. */
  private async ensureDir(dir: string): Promise<void> {
    await mkdir(this.dir!, { recursive: true, mode: 0o700 });
    await chmod(this.dir!, 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }

  /** Write the snapshot durably. Throws if it could not be written. */
  async save(snapshot: PageSnapshot): Promise<string> {
    const dir = this.pageDir(snapshot.pageId);
    await this.ensureDir(dir);

    const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");
    const name = `${stamp}_${snapshot.operation}.json`;
    const tmp = join(dir, `.${name}.tmp`);
    const file = join(dir, name);

    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(snapshot), "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);

    // Pruning is best effort: the new snapshot is already safe on disk.
    await this.prune(snapshot.pageId, true).catch((err) =>
      console.error(`Backup prune failed for ${snapshot.pageId}: ${err.message}`),
    );
    return file;
  }

  /** Snapshots for a page, newest first. */
  async list(pageId: string): Promise<BackupEntry[]> {
    const dir = this.pageDir(pageId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .sort()
      .reverse()
      .map((n) => {
        const [stamp, operation = ""] = n.replace(/\.json$/, "").split("_");
        return { file: join(dir, n), capturedAt: unstamp(stamp), operation };
      });
  }

  /**
   * Read one snapshot of a page by its file name, as returned by list. Only
   * names in the exact backup format are accepted, so a name cannot reach
   * outside the page's folder.
   */
  async read(pageId: string, name: string): Promise<PageSnapshot> {
    if (!BACKUP_NAME.test(name)) {
      throw new Error(`"${name}" is not a backup file name; use one from list_page_backups.`);
    }
    let text: string;
    try {
      text = await readFile(join(this.pageDir(pageId), name), "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new Error(`No backup "${name}" for page ${pageId}; it may have expired. Use list_page_backups.`);
      }
      throw err;
    }
    const snapshot = JSON.parse(text) as PageSnapshot;
    if (snapshot.pageId !== pageId) {
      throw new Error(`Backup "${name}" belongs to page ${snapshot.pageId}, not ${pageId}.`);
    }
    return snapshot;
  }

  /**
   * Keep at most keepPerPage snapshots and drop those older than maxAgeDays.
   * After a save (keepNewest) the snapshot just written always survives.
   * Returns how many files were removed.
   */
  private async prune(pageId: string, keepNewest: boolean): Promise<number> {
    const entries = await this.list(pageId);
    const cutoff = Date.now() - this.maxAgeDays * 86_400_000;
    let removed = 0;
    for (const [i, entry] of entries.entries()) {
      if (i === 0 && keepNewest) continue;
      const tooMany = i >= this.keepPerPage;
      const capturedAt = Date.parse(entry.capturedAt);
      const tooOld = !Number.isFinite(capturedAt) || capturedAt < cutoff;
      if (tooMany || tooOld) {
        await unlink(entry.file);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Apply the retention limits to every page folder, including pages that
   * will never be written again (deleted or no longer edited), whose backups
   * would otherwise outlive maxAgeDays. Run at startup. A page's newest
   * snapshot expires too once it is past the age limit.
   */
  async sweep(): Promise<{ pages: number; removed: number; emptied: number }> {
    const result = { pages: 0, removed: 0, emptied: 0 };
    if (!this.dir) return result;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err: any) {
      if (err.code === "ENOENT") return result;
      throw err;
    }
    await chmod(this.dir, 0o700);
    for (const name of names) {
      if (!PAGE_ID.test(name)) continue;
      const dir = join(this.dir, name);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue; // not a folder
      }
      result.pages++;
      // Leftover temp files are from interrupted writes and never complete.
      for (const f of files.filter((f) => f.startsWith(".") && f.endsWith(".tmp"))) {
        await unlink(join(dir, f));
        result.removed++;
      }
      result.removed += await this.prune(name, false);
      if ((await readdir(dir)).length === 0) {
        await rmdir(dir);
        result.emptied++;
      }
    }
    return result;
  }
}

// 2026-10-27T10-15-30-123Z -> 2026-10-27T10:15:30.123Z
function unstamp(stamp: string): string {
  return stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1$2:$3:$4.$5Z",
  );
}
