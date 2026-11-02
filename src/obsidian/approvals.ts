/** Browser-held capabilities never enter model messages or MCP tool results. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  executeApprovedDelete,
  executeApprovedWrite,
  prepareVaultDelete,
  prepareVaultWrite,
  vaultErrorMessage,
  PartialDeleteError,
  type DeleteSnapshot,
  type WriteProposal,
  type WriteSnapshot,
} from './vault.js';

export const APPROVAL_TTL_MS = 5 * 60_000;
const MAX_PENDING = 100;
export interface VaultApproval {
  readonly id: string;
  readonly token: string;
  readonly model: string;
  readonly operation: 'create' | 'edit' | 'delete';
  readonly files: readonly string[];
  readonly expiresAt: string;
  readonly before?: string;
  readonly after?: string;
}
interface Pending {
  readonly signal: AbortSignal;
  readonly token: string;
  readonly snapshot:
    { kind: 'delete'; value: DeleteSnapshot } | { kind: 'write'; value: WriteSnapshot };
  readonly finish: (result: unknown) => void;
  readonly claim: () => void;
}
const pending = new Map<string, Pending>();
const request = (
  snapshot: Pending['snapshot'],
  model: string,
  emit: (event: Readonly<Record<string, unknown>>) => void | Promise<void>,
  signal: AbortSignal,
): Promise<unknown> => {
  signal.throwIfAborted();
  if (pending.size >= MAX_PENDING) throw new Error('Too many pending vault requests');
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    const finish = (result: unknown): void => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      resolve(result);
    };
    const cancel = (): void => finish({ cancelled: true, deleted: [] });
    const timer = setTimeout(cancel, APPROVAL_TTL_MS);
    timer.unref?.();
    const claim = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    };
    pending.set(id, { token, snapshot, finish, signal, claim });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      Promise.resolve(
        emit({
          type: 'vault-approval',
          approval: {
            id,
            token,
            model,
            operation: snapshot.kind === 'delete' ? 'delete' : snapshot.value.operation,
            files:
              snapshot.kind === 'delete'
                ? snapshot.value.files.map((file) => file.path)
                : [snapshot.value.path],
            ...(snapshot.kind === 'write'
              ? { before: snapshot.value.before, after: snapshot.value.content }
              : {}),
            expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
          },
        }),
      ).catch((error) => {
        pending.delete(id);
        claim();
        reject(error);
      });
    } catch (error) {
      pending.delete(id);
      claim();
      reject(error);
    }
    if (signal.aborted) cancel();
  });
};
export const requestVaultDeletion = async (
  paths: unknown,
  model: string,
  emit: (event: Readonly<Record<string, unknown>>) => void | Promise<void>,
  signal: AbortSignal,
): Promise<unknown> =>
  request({ kind: 'delete', value: await prepareVaultDelete(paths) }, model, emit, signal);
export const requestVaultWrite = async (
  proposal: WriteProposal,
  model: string,
  emit: (event: Readonly<Record<string, unknown>>) => void | Promise<void>,
  signal: AbortSignal,
): Promise<unknown> =>
  request({ kind: 'write', value: await prepareVaultWrite(proposal) }, model, emit, signal);

/** A human click plus a browser-only capability authorizes precisely the captured revision/content. */
export const decideVaultDeletion = async (id: unknown, input: unknown): Promise<void> => {
  const body = input as { token?: unknown; approve?: unknown; acknowledged?: unknown } | null;
  const item = typeof id === 'string' ? pending.get(id) : undefined;
  if (
    !item ||
    typeof body?.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.token) ||
    !timingSafeEqual(Buffer.from(item.token), Buffer.from(body.token))
  )
    throw new Error('Vault request expired or its confirmation token is invalid');
  if (typeof body.approve !== 'boolean')
    throw new Error('An explicit approval decision is required');
  if (!body.approve) {
    item.finish({ cancelled: true, deleted: [] });
    return;
  }
  if (body.acknowledged !== true)
    throw new Error('Check the confirmation box before changing notes');
  pending.set(id as string, { ...item, token: randomBytes(32).toString('hex') });
  item.claim();
  try {
    item.signal.throwIfAborted();
    if (item.snapshot.kind === 'delete')
      item.finish(await executeApprovedDelete(item.snapshot.value, item.signal));
    else {
      const note = await executeApprovedWrite(item.snapshot.value, item.signal);
      item.finish({
        path: note.path,
        revision: note.revision,
        [item.snapshot.value.operation === 'create' ? 'created' : 'edited']: true,
      });
    }
  } catch (error) {
    const message = vaultErrorMessage(error, 'Vault change failed');
    item.finish({
      error: message,
      deleted: error instanceof PartialDeleteError ? [...error.deleted] : [],
    });
    throw new Error(message, { cause: error });
  }
};
