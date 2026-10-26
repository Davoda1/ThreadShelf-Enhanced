import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFolderImportJob } from '../../src/import-jobs.js';
import { indexingDataPath } from '../../src/indexing-coordinator.js';
import { withInterprocessLock } from '../../src/interprocess-lock.js';

if (process.argv[2] === 'hold') {
  await withInterprocessLock(
    indexingDataPath('.coordination', 'import-inputs'),
    () =>
      new Promise((resolve) => {
        process.send?.({ state: 'owned' });
        process.once('message', resolve);
      }),
  );
} else {
  const folderPath = join(process.env.UPLOADS_DIR, 'alpha');
  const job = await createFolderImportJob({ collection: 'alpha', folderPath, autoStart: false });
  process.send?.({
    state: 'accepted',
    id: job.id,
    sourcePresent: existsSync(join(folderPath, 'one.json')),
  });
}
process.exit(0);
