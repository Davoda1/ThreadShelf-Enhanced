import { test, expect } from './fixtures.js';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stopChildProcess } from '../shared/helpers.js';

const worker = fileURLToPath(new URL('../shared/indexing-coordinator-worker.js', import.meta.url));
const holdIndexer = async (database) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const child = spawn(process.execPath, ['--import', 'tsx', worker, 'index'], {
      env: { ...process.env, LANCEDB_PATH: database },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Index coordinator did not reply')), 10_000);
      child.once('message', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (message.state === 'owned') return child;
    await stopChildProcess(child);
    await delay(50);
  }
  throw new Error('Could not hold the isolated test indexer');
};

const submitNotes = async (page) => {
  await page.locator('#indexingNavBtn').click();
  await page.locator('#exportFileInput').setInputFiles({
    name: 'synthetic-notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"ordinary_notes":"This is an unrelated synthetic document."}'),
  });
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/import-jobs/upload') && response.request().method() === 'POST',
  );
  await page.locator('#ingestBtn').click();
  const response = await responsePromise;
  expect(response.status()).toBe(202);
  const { job } = await response.json();
  const card = page.locator(`.import-job[data-job-id="${job.id}"]`);
  await expect(card).toHaveAttribute('data-state', 'queued');
  await expect(card).toContainText('You can close this tab');
  return { job, card };
};

test('closing and reopening the browser tab retains the accepted job and its final diagnostics', async ({
  appPage,
  context,
  serverContext,
}) => {
  const blocker = await holdIndexer(join(serverContext.tempRoot, '.lancedb'));
  let reopened;
  try {
    const { job } = await submitNotes(appPage);
    await appPage.close();
    reopened = await context.newPage();
    await reopened.goto(`${serverContext.baseUrl}/indexing`);
    const card = reopened.locator(`.import-job[data-job-id="${job.id}"]`);
    await expect(card).toHaveAttribute('data-state', 'queued');
    await stopChildProcess(blocker);
    await expect(card).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
    await card.getByText('Skipped files and diagnostics').click();
    await expect(card).toContainText('synthetic-notes.json');
    await reopened.reload();
    await expect(reopened.locator(`.import-job[data-job-id="${job.id}"]`)).toHaveAttribute(
      'data-state',
      'completed',
    );
    await expect(card.getByRole('progressbar')).toHaveAttribute('value', '100');
    await expect(
      card.getByRole('button', { name: 'Clear this import from history', exact: true }),
    ).toHaveText('Clear');
    await card.getByRole('button', { name: 'Clear this import from history', exact: true }).click();
    const confirmation = reopened.getByRole('alertdialog');
    await expect(confirmation).toContainText('Imported conversations stay unchanged.');
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Clear this import from history', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Remove from history', exact: true }).click();
    await expect(card).toHaveCount(0);
    await reopened.reload();
    await expect(card).toHaveCount(0);
    const removed = await reopened.request.get(
      `${serverContext.baseUrl}/api/import-jobs/${job.id}`,
    );
    expect(removed.status()).toBe(404);
  } finally {
    await stopChildProcess(blocker);
    await reopened?.close();
  }
});

test('job cards cancel and retry accepted work explicitly', async ({ appPage, serverContext }) => {
  const blocker = await holdIndexer(join(serverContext.tempRoot, '.lancedb'));
  try {
    const { card } = await submitNotes(appPage);
    await expect(
      card.getByRole('button', { name: 'Clear this import from history', exact: true }),
    ).toHaveCount(0);
    await card.getByRole('button', { name: 'Cancel import', exact: true }).click();
    await appPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel import', exact: true })
      .click();
    await expect(card).toHaveAttribute('data-state', 'cancelled');
    await card.getByRole('button', { name: 'Retry import', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'queued');
    await stopChildProcess(blocker);
    await expect(card).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  } finally {
    await stopChildProcess(blocker);
  }
});

const uploadSyntheticNotes = async (request, baseUrl, name) => {
  const response = await request.post(`${baseUrl}/api/import-jobs/upload`, {
    multipart: {
      collectionName: 'pw_fixture',
      clearFirst: 'false',
      file: {
        name: `${name}.json`,
        mimeType: 'application/json',
        buffer: Buffer.from('{"ordinary_notes":"Synthetic import history test."}'),
      },
    },
  });
  expect(response.status()).toBe(202);
  return (await response.json()).job;
};

test('bulk history clearing reaches older jobs and preserves active work after reload', async ({
  appPage,
  serverContext,
}) => {
  const created = [];
  for (let i = 0; i < 25; i++) {
    created.push(
      await uploadSyntheticNotes(appPage.request, serverContext.baseUrl, `history-${i}`),
    );
  }
  await expect
    .poll(
      async () => {
        const response = await appPage.request.get(`${serverContext.baseUrl}/api/import-jobs`);
        const { jobs } = await response.json();
        return created.every((createdJob) =>
          jobs.some((job) => job.id === createdJob.id && job.state === 'completed'),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  const blocker = await holdIndexer(join(serverContext.tempRoot, '.lancedb'));
  let active;
  try {
    active = await uploadSyntheticNotes(appPage.request, serverContext.baseUrl, 'history-active');
    await appPage.goto(`${serverContext.baseUrl}/indexing`);
    await expect(appPage.locator('.import-job')).toHaveCount(20);
    await expect(appPage.locator('#clearFinishedImportJobs')).toHaveText('Clear all');
    const activeCard = appPage.locator(`.import-job[data-job-id="${active.id}"]`);
    await expect(activeCard).toHaveAttribute('data-state', 'queued');
    await expect(
      activeCard.getByRole('button', { name: 'Clear this import from history', exact: true }),
    ).toHaveCount(0);
    await appPage.locator('#clearFinishedImportJobs').click();
    const confirmation = appPage.getByRole('alertdialog');
    await expect(confirmation).toContainText('including older jobs not shown here');
    await expect(confirmation).toContainText('Imported conversations stay unchanged.');
    await confirmation.getByRole('button', { name: 'Clear finished jobs', exact: true }).click();
    await expect(appPage.locator('.import-job')).toHaveCount(1);
    await expect(activeCard).toHaveAttribute('data-state', 'queued');
    await appPage.reload();
    await expect(appPage.locator('.import-job')).toHaveCount(1);
    const response = await appPage.request.get(`${serverContext.baseUrl}/api/import-jobs`);
    expect((await response.json()).jobs.map((job) => job.id)).toEqual([active.id]);
    const preserved = await appPage.request.delete(
      `${serverContext.baseUrl}/api/import-jobs/${active.id}`,
    );
    expect(preserved.status()).toBe(409);
  } finally {
    if (active)
      await appPage.request.post(`${serverContext.baseUrl}/api/import-jobs/${active.id}/cancel`);
    await stopChildProcess(blocker);
  }
});

test('old completed progress is 100%, unfinished progress stays accurate and failed removal is recoverable', async ({
  appPage,
  serverContext,
}) => {
  const states = ['completed', 'failed', 'cancelled', 'queued', 'running', 'paused', 'interrupted'];
  const jobs = states.map((state, i) => ({
    id: `history-ui-${state}`,
    collection: `synthetic_${state}`,
    kind: 'folder',
    state,
    clearFirst: false,
    createdAt: i,
    updatedAt: i,
    progress: { phase: 'embedding', progressPercent: 95, totalFiles: 1, processedFiles: 1 },
    cancelRequested: false,
    attempts: 1,
    safeToClose: true,
    collectionLocked: false,
  }));
  await appPage.route('**/api/import-jobs', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({ json: { jobs } });
  });
  let releaseRemoval;
  const removalWaiting = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  await appPage.route('**/api/import-jobs/history-ui-failed', async (route) => {
    await removalWaiting;
    await route.fulfill({
      status: 409,
      json: { error: 'Synthetic removal conflict. Please refresh and retry.' },
    });
  });
  try {
    await appPage.goto(`${serverContext.baseUrl}/indexing`);
    for (const state of states) {
      const card = appPage.locator(`.import-job[data-job-id="history-ui-${state}"]`);
      await expect(card.getByRole('progressbar')).toHaveAttribute(
        'value',
        state === 'completed' ? '100' : '95',
      );
      await expect(
        card.getByRole('button', { name: 'Clear this import from history', exact: true }),
      ).toHaveCount(['completed', 'failed', 'cancelled'].includes(state) ? 1 : 0);
    }
    const failed = appPage.locator('.import-job[data-job-id="history-ui-failed"]');
    await failed
      .getByRole('button', { name: 'Clear this import from history', exact: true })
      .click();
    await appPage
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Remove from history', exact: true })
      .click();
    await expect(appPage.locator('#clearFinishedImportJobs')).toBeDisabled();
    await expect(failed.getByRole('button', { name: 'Retry import', exact: true })).toBeDisabled();
    await expect(failed).toBeVisible();
    releaseRemoval();
    await expect(appPage.getByRole('alert')).toContainText('Synthetic removal conflict.');
    await expect(failed).toBeVisible();
    await expect(appPage.locator('#clearFinishedImportJobs')).toBeEnabled();
    await expect(
      failed.getByRole('button', { name: 'Clear this import from history', exact: true }),
    ).toBeEnabled();
  } finally {
    releaseRemoval();
  }
});
