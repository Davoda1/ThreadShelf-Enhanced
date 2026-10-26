import { readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { posix } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';

const MiB = 1024 ** 2;
// /proc mount and cgroup paths use POSIX syntax on every test host.
const { dirname, join, resolve } = posix;
export interface MemoryStatus {
  readonly sampledAt: number;
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly reserveBytes: number;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly heapLimitBytes: number;
  readonly externalBytes: number;
  readonly processBudgetBytes: number;
  readonly pressure: 'normal' | 'throttled' | 'paused' | 'critical';
  readonly reason: 'available' | 'process' | 'heap' | null;
}
export interface MemorySample {
  totalBytes: number;
  availableBytes: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
}
export interface MemoryPolicy {
  reserveBytes: number;
  processBudgetBytes: number;
}

const envMiB = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 128 && value <= 1048576 ? value * MiB : fallback;
};
type TextReader = (path: string) => string;
const readText: TextReader = (path) => readFileSync(path, 'utf8');
const readNumber = (path: string, reader: TextReader = readText): number | undefined => {
  try {
    const value = Number(reader(path).trim());
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
};
const readCounters = (path: string, reader: TextReader = readText): Record<string, number> => {
  try {
    return Object.fromEntries(
      reader(path)
        .trim()
        .split('\n')
        .map((line) => {
          const [key = '', raw = '0'] = line.trim().split(/\s+/);
          return [key.replace(/:$/, ''), Number(raw)];
        }),
    );
  } catch {
    return {};
  }
};

export interface CgroupMemoryDirectory {
  readonly path: string;
  readonly version: 1 | 2;
}

/** Resolve every visible ancestor: a parent can impose a tighter limit than its child. */
export const cgroupMemoryDirectories = (
  membership: string,
  mountinfo: string,
): readonly CgroupMemoryDirectory[] => {
  const groups = membership
    .split('\n')
    .filter((line) => /^\d+:[^:]*:\//.test(line))
    .map((line) => {
      const first = line.indexOf(':'),
        second = line.indexOf(':', first + 1);
      return {
        controllers: line.slice(first + 1, second).split(','),
        path: line.slice(second + 1),
      };
    });
  const decode = (value: string) =>
    value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8)),
    );
  const mounts: { root: string; path: string; version: 1 | 2 }[] = [];
  for (const line of mountinfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (!before || !after) continue;
    const fields = before.split(' '),
      [type, , options = ''] = after.split(' ');
    const version =
      type === 'cgroup2'
        ? 2
        : type === 'cgroup' && options.split(',').includes('memory')
          ? 1
          : undefined;
    if (version && fields[3] && fields[4])
      mounts.push({ root: decode(fields[3]), path: decode(fields[4]), version });
  }
  // Restricted containers may hide mountinfo or report a cgroup outside their
  // namespace. Still sample the mounted root rather than assuming host capacity.
  if (!mounts.some((mount) => mount.version === 2))
    mounts.push({ root: '/', path: '/sys/fs/cgroup', version: 2 });
  if (!mounts.some((mount) => mount.version === 1))
    mounts.push({ root: '/', path: '/sys/fs/cgroup/memory', version: 1 });
  const directories = new Map<string, CgroupMemoryDirectory>();
  for (const mount of mounts) {
    const base = resolve(mount.path);
    directories.set(`${mount.version}:${base}`, { path: base, version: mount.version });
    const group = groups.find((entry) =>
      mount.version === 2
        ? entry.controllers.length === 1 && entry.controllers[0] === ''
        : entry.controllers.includes('memory'),
    );
    if (!group?.path.startsWith('/') || group.path.split('/').includes('..')) continue;
    const relative =
      mount.root !== '/' && (group.path === mount.root || group.path.startsWith(`${mount.root}/`))
        ? group.path.slice(mount.root.length)
        : group.path;
    let current = resolve(base, relative.replace(/^\/+/, ''));
    while (current === base || current.startsWith(`${base}/`)) {
      directories.set(`${mount.version}:${current}`, { path: current, version: mount.version });
      if (current === base) break;
      current = dirname(current);
    }
  }
  return [...directories.values()];
};

/** Injectable filesystem reader keeps hierarchy/pressure tests independent of the host. */
export const cgroupMemoryLimits = (
  directories: readonly CgroupMemoryDirectory[],
  reader: TextReader = readText,
): { totalBytes?: number; availableBytes?: number } => {
  let totalBytes = Infinity,
    availableBytes = Infinity;
  for (const root of directories) {
    const limit = readNumber(
      join(root.path, root.version === 2 ? 'memory.max' : 'memory.limit_in_bytes'),
      reader,
    );
    const used = readNumber(
      join(root.path, root.version === 2 ? 'memory.current' : 'memory.usage_in_bytes'),
      reader,
    );
    if (limit === undefined) continue;
    totalBytes = Math.min(totalBytes, limit);
    // Even when usage is hidden, keep the finite total bound. Missing counters
    // cannot provide a trustworthy estimate of how much of that bound is free.
    if (used !== undefined)
      availableBytes = Math.min(
        availableBytes,
        cgroupAvailableMemory(limit, used, readCounters(join(root.path, 'memory.stat'), reader)),
      );
  }
  return {
    ...(Number.isFinite(totalBytes) ? { totalBytes } : {}),
    ...(Number.isFinite(availableBytes) ? { availableBytes } : {}),
  };
};

let mountSnapshot: { at: number; text: string } | undefined;
const visibleCgroupDirectories = (): readonly CgroupMemoryDirectory[] => {
  let membership = '';
  try {
    membership = readText('/proc/self/cgroup');
  } catch {
    /* Restricted procfs. */
  }
  if (!mountSnapshot || Date.now() - mountSnapshot.at >= 5000) {
    let text = '';
    try {
      text = readText('/proc/self/mountinfo');
    } catch {
      /* Use conventional roots. */
    }
    mountSnapshot = { at: Date.now(), text };
  }
  return cgroupMemoryDirectories(membership, mountSnapshot.text);
};

/** Clean page-cache pages, including active pages, can be reclaimed by the kernel. */
export const cgroupAvailableMemory = (
  limit: number,
  used: number,
  stat: Record<string, number>,
): number => {
  const file = stat.file ?? stat.total_cache ?? stat.cache;
  const hierarchicalV1 = stat.file === undefined && stat.total_cache !== undefined;
  const shmem = hierarchicalV1
    ? (stat.total_shmem ?? stat.shmem)
    : (stat.shmem ?? stat.total_shmem);
  const dirty = hierarchicalV1 ? (stat.total_dirty ?? stat.dirty) : (stat.file_dirty ?? stat.dirty);
  const writeback = hierarchicalV1
    ? (stat.total_writeback ?? stat.writeback)
    : (stat.file_writeback ?? stat.writeback);
  const mapped = hierarchicalV1
    ? (stat.total_mapped_file ?? stat.mapped_file)
    : (stat.file_mapped ?? stat.mapped_file);
  const clean =
    file === undefined
      ? (stat.total_inactive_file ?? stat.inactive_file ?? 0)
      : Math.max(0, file - (shmem ?? 0) - (dirty ?? 0) - (writeback ?? 0) - (mapped ?? 0));
  // Retain a margin: not every reclaimable page can be reclaimed immediately.
  const reclaimable = clean * 0.8 + (stat.slab_reclaimable ?? 0) * 0.5;
  return Math.min(limit, Math.max(0, limit - used + reclaimable));
};

/** Account for reclaimable file cache and the actual container limit on Linux. */
export const systemMemory = (): { totalBytes: number; availableBytes: number } => {
  let totalBytes = totalmem();
  let availableBytes = freemem();
  if (process.platform === 'linux') {
    const mem = readCounters('/proc/meminfo');
    if (mem.MemAvailable !== undefined) availableBytes = mem.MemAvailable * 1024;
    const cgroup = cgroupMemoryLimits(visibleCgroupDirectories());
    if (cgroup.totalBytes !== undefined) totalBytes = Math.min(totalBytes, cgroup.totalBytes);
    if (cgroup.availableBytes !== undefined)
      availableBytes = Math.min(availableBytes, cgroup.availableBytes);
  } else if (typeof process.availableMemory === 'function') {
    availableBytes = Math.min(availableBytes, process.availableMemory());
  }
  return { totalBytes, availableBytes: Math.min(totalBytes, Math.max(0, availableBytes)) };
};

export const evaluateMemory = (sample: MemorySample, policy: MemoryPolicy): MemoryStatus => {
  const heapRatio = sample.heapLimitBytes > 0 ? sample.heapUsedBytes / sample.heapLimitBytes : 0;
  let pressure: MemoryStatus['pressure'] = 'normal';
  let reason: MemoryStatus['reason'] = null;
  if (sample.rssBytes >= policy.processBudgetBytes || heapRatio >= 0.92) {
    pressure = 'critical';
    reason = heapRatio >= 0.92 ? 'heap' : 'process';
  } else if (sample.availableBytes < policy.reserveBytes) {
    pressure = 'paused';
    reason = 'available';
  } else if (
    sample.availableBytes < policy.reserveBytes * 1.5 ||
    sample.rssBytes > policy.processBudgetBytes * 0.75 ||
    heapRatio > 0.78
  ) {
    pressure = 'throttled';
    reason =
      heapRatio > 0.78
        ? 'heap'
        : sample.rssBytes > policy.processBudgetBytes * 0.75
          ? 'process'
          : 'available';
  }
  return { ...sample, ...policy, pressure, reason, sampledAt: Date.now() };
};

let cached: MemoryStatus | undefined;
export const getMemoryStatus = (fresh = false): MemoryStatus => {
  if (!fresh && cached && Date.now() - cached.sampledAt < 500) return cached;
  const system = systemMemory();
  const memory = process.memoryUsage();
  const reserveBytes = Math.min(
    system.totalBytes * 0.4,
    envMiB(
      'THREADSHELF_MEMORY_RESERVE_MB',
      Math.max(512 * MiB, Math.min(2048 * MiB, system.totalBytes * 0.15)),
    ),
  );
  const processBudgetBytes = Math.min(
    system.totalBytes - reserveBytes,
    envMiB(
      'THREADSHELF_PROCESS_MEMORY_MB',
      Math.max(512 * MiB, Math.min(6144 * MiB, system.totalBytes * 0.45)),
    ),
  );
  cached = evaluateMemory(
    {
      ...system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      externalBytes: memory.external,
    },
    { reserveBytes, processBudgetBytes },
  );
  return cached;
};

export class MemoryPressureError extends Error {
  readonly code = 'MEMORY_PRESSURE';
  constructor(readonly status: MemoryStatus) {
    super(
      'Import stopped safely because the memory budget was reached. Free memory or lower the embedding batch size, then retry.',
    );
    this.name = 'MemoryPressureError';
  }
}

export interface MemoryCheckpointOptions {
  readonly signal?: AbortSignal;
  readonly onPressure?: (status: MemoryStatus) => void | Promise<void>;
  /** Injectable for deterministic tests; production uses real measurements. */
  readonly sample?: () => MemoryStatus;
  readonly pollMs?: number;
  readonly maxPauseMs?: number;
}

/** Cooperatively stop before allocating another batch; never kill another process. */
export const memoryCheckpoint = async (options: MemoryCheckpointOptions = {}): Promise<void> => {
  const sample = options.sample ?? (() => getMemoryStatus(true));
  const maxPauseMs = options.maxPauseMs ?? 120_000;
  const started = performance.now();
  let lastPressure: MemoryStatus['pressure'] | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const status = sample();
    if (status.pressure !== lastPressure) await options.onPressure?.(status);
    lastPressure = status.pressure;
    if (status.pressure === 'critical') throw new MemoryPressureError(status);
    if (status.pressure !== 'paused') return;
    if (performance.now() - started >= maxPauseMs) throw new MemoryPressureError(status);
    await delay(options.pollMs ?? 1000, undefined, { signal: options.signal });
  }
};

export const recommendedBatchSize = (requested: number): number => {
  const size = Number.isFinite(requested) ? Math.max(1, Math.min(256, Math.floor(requested))) : 25;
  const state = getMemoryStatus();
  return state.pressure === 'normal' ? size : Math.max(1, Math.floor(size / 4));
};

/** Timer keeps a recent process/system sample even when no importer is active. */
export const startMemoryWatcher = (): (() => void) => {
  getMemoryStatus(true);
  const timer = setInterval(() => getMemoryStatus(true), 2000);
  timer.unref();
  return () => clearInterval(timer);
};
