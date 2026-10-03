import { mkdir, lstat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const RECEIPT_NAME = 'last-receipt.json';

export async function reserveReceipt(workspace, { beforeReceiptDirectoryOpen } = {}) {
  const root = await open(workspace, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const directory = `${workspace}/.yolo`;
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('receipt directory is not a local directory');
    await beforeReceiptDirectoryOpen?.();
    const yolo = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const after = await yolo.stat();
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('receipt directory changed during persistence');
      let file;
      try {
        file = await open(`${directory}/${RECEIPT_NAME}`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') {
          await yolo.close();
          await root.close();
          return null;
        }
        throw error;
      }
      let closed = false;
      return {
        async write(receipt) {
          if (closed) throw new Error('receipt authority is closed');
          await file.writeFile(`${JSON.stringify(receipt)}\n`);
          await file.sync();
          await yolo.sync();
        },
        async close() {
          if (closed) return;
          closed = true;
          try { await file.close(); } finally {
            try { await yolo.close(); } finally { await root.close(); }
          }
        },
      };
    } catch (error) {
      await yolo.close();
      throw error;
    }
  } catch (error) {
    await root.close();
    throw error;
  }
}

export async function persistReceipt(workspace, receipt, options = {}) {
  const authority = await reserveReceipt(workspace, options);
  if (!authority) return false;
  try {
    await authority.write(receipt);
    return true;
  } finally {
    await authority.close();
  }
}
