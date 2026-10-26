import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMemory,
  memoryCheckpoint,
  MemoryPressureError,
  systemMemory,
  cgroupAvailableMemory,
  cgroupMemoryDirectories,
  cgroupMemoryLimits,
} from '../src/memory-governor.ts';

const MiB = 1024 ** 2;
const sample = {
  totalBytes: 16384 * MiB,
  availableBytes: 8192 * MiB,
  rssBytes: 512 * MiB,
  heapUsedBytes: 256 * MiB,
  heapLimitBytes: 4096 * MiB,
  externalBytes: 64 * MiB,
};
const policy = { reserveBytes: 2048 * MiB, processBudgetBytes: 6144 * MiB };
const state = (override = {}) => evaluateMemory({ ...sample, ...override }, policy);

test('container clean active file cache counts as reclaimable while dirty and mapped pages retain headroom', () => {
  const available = cgroupAvailableMemory(8192 * MiB, 8000 * MiB, {
    file: 6000 * MiB,
    inactive_file: 500 * MiB,
    file_dirty: 500 * MiB,
    file_mapped: 100 * MiB,
    shmem: 200 * MiB,
  });
  assert.equal(available, (192 + 5200 * 0.8) * MiB);
  assert.equal(
    cgroupAvailableMemory(8192 * MiB, 8000 * MiB, { file: 6000 * MiB, file_dirty: 6000 * MiB }),
    192 * MiB,
  );
  assert.ok(cgroupAvailableMemory(100, 20, { file: 10000 }) <= 100);
});

test('intermediate cgroup v2 limits and sibling usage constrain the process even when its leaf is unlimited', () => {
  const roots = cgroupMemoryDirectories(
    '0::/tenant/jobs/importer\n',
    '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw',
  );
  assert.ok(roots.some((root) => root.path === '/sys/fs/cgroup/tenant'));
  const counters = {
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/tenant/memory.max': String(4096 * MiB),
    '/sys/fs/cgroup/tenant/memory.current': String(3900 * MiB),
    '/sys/fs/cgroup/tenant/memory.stat': 'file 0\n',
    '/sys/fs/cgroup/tenant/jobs/memory.max': String(8192 * MiB),
    '/sys/fs/cgroup/tenant/jobs/memory.current': String(256 * MiB),
    '/sys/fs/cgroup/tenant/jobs/importer/memory.max': 'max',
  };
  const result = cgroupMemoryLimits(roots, (path) => {
    if (!(path in counters)) throw new Error('No synthetic counter');
    return counters[path];
  });
  assert.deepEqual(result, { totalBytes: 4096 * MiB, availableBytes: 196 * MiB });
  assert.equal(state({ ...result }).pressure, 'paused');
});

test('nested cgroup v1 memory controller resolves its actual mount and prefers hierarchical cache counters', () => {
  const roots = cgroupMemoryDirectories(
    '8:cpu,cpuacct:/unrelated\n7:memory:/tenant/jobs/importer\n',
    '31 23 0:27 /tenant /custom\\040cgroup rw - cgroup memory rw,memory',
  );
  assert.deepEqual(
    roots.filter((root) => root.version === 1).map((root) => root.path),
    ['/custom cgroup', '/custom cgroup/jobs/importer', '/custom cgroup/jobs'],
  );
  const counters = {
    '/custom cgroup/memory.limit_in_bytes': String(4096 * MiB),
    '/custom cgroup/memory.usage_in_bytes': String(4000 * MiB),
    '/custom cgroup/memory.stat': `cache 0\ntotal_cache ${1000 * MiB}\nshmem 0\ntotal_shmem ${900 * MiB}\ndirty 0\ntotal_dirty ${50 * MiB}\n`,
  };
  const result = cgroupMemoryLimits(roots, (path) => {
    if (!(path in counters)) throw new Error('No synthetic counter');
    return counters[path];
  });
  assert.deepEqual(result, { totalBytes: 4096 * MiB, availableBytes: 136 * MiB });
});

test('hidden or outside-namespace memberships retain mounted roots without traversing outside them', () => {
  const roots = cgroupMemoryDirectories(
    '0::/../../host/container\n',
    '29 23 0:26 /hidden/tenant /sys/fs/cgroup rw - cgroup2 cgroup rw',
  );
  assert.deepEqual(
    roots.filter((root) => root.version === 2),
    [{ path: '/sys/fs/cgroup', version: 2 }],
  );
  assert.ok(cgroupMemoryDirectories('', '').some((root) => root.path === '/sys/fs/cgroup'));
  const hiddenUsage = cgroupMemoryLimits([{ path: '/synthetic', version: 2 }], (path) => {
    if (path.endsWith('memory.max')) return String(1024 * MiB);
    throw new Error('Counter hidden');
  });
  assert.deepEqual(hiddenUsage, { totalBytes: 1024 * MiB });
});

test('memory pressure includes total resident native allocations, not only heap', () => {
  assert.equal(state().pressure, 'normal');
  assert.equal(state({ rssBytes: 5000 * MiB }).pressure, 'throttled');
  assert.equal(state({ rssBytes: 6144 * MiB }).reason, 'process');
  assert.equal(state({ heapUsedBytes: 4000 * MiB }).reason, 'heap');
  assert.equal(state({ availableBytes: 1024 * MiB }).pressure, 'paused');
});

test('memory checkpoint pauses until headroom returns and reports resumed status', async () => {
  const samples = [
    state({ availableBytes: 512 * MiB }),
    state({ availableBytes: 512 * MiB }),
    state(),
  ];
  const statuses = [];
  await memoryCheckpoint({
    sample: () => samples.shift() ?? state(),
    pollMs: 1,
    onPressure: (s) => statuses.push(s.pressure),
  });
  assert.deepEqual(statuses, ['paused', 'normal']);
});

test('critical process budget and sustained pressure fail controllably', async () => {
  await assert.rejects(
    memoryCheckpoint({ sample: () => state({ rssBytes: 8000 * MiB }) }),
    MemoryPressureError,
  );
  await assert.rejects(
    memoryCheckpoint({ sample: () => state({ availableBytes: 1 }), maxPauseMs: 0 }),
    { code: 'MEMORY_PRESSURE' },
  );
});

test('memory pauses are cancellable and host estimates are bounded', async () => {
  const controller = new AbortController();
  const pending = memoryCheckpoint({
    sample: () => state({ availableBytes: 1 }),
    signal: controller.signal,
    pollMs: 10,
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const actual = systemMemory();
  assert.ok(actual.totalBytes > 0);
  assert.ok(actual.availableBytes >= 0 && actual.availableBytes <= actual.totalBytes);
});
