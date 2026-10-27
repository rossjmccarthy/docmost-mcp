import { mkdir, open, readdir, rename, unlink } from "fs/promises";
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

  /** Write the snapshot durably. Throws if it could not be written. */
  async save(snapshot: PageSnapshot): Promise<string> {
    const dir = this.pageDir(snapshot.pageId);
    await mkdir(dir, { recursive: true });

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
    await this.prune(snapshot.pageId).catch((err) =>
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
   * Keep at most keepPerPage snapshots and drop those older than maxAgeDays.
   * Only runs right after a save, so the newest snapshot always survives.
   */
  private async prune(pageId: string): Promise<void> {
    const entries = await this.list(pageId);
    const cutoff = Date.now() - this.maxAgeDays * 86_400_000;
    for (const [i, entry] of entries.entries()) {
      if (i === 0) continue;
      const tooMany = i >= this.keepPerPage;
      const tooOld = Date.parse(entry.capturedAt) < cutoff;
      if (tooMany || tooOld) await unlink(entry.file);
    }
  }
}

// 2026-10-27T10-15-30-123Z -> 2026-10-27T10:15:30.123Z
function unstamp(stamp: string): string {
  return stamp.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1$2:$3:$4.$5Z",
  );
}
