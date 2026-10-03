import { mkdir, lstat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const RECEIPT_NAME = 'last-receipt.json';

export async function persistReceipt(workspace, receipt) {
  const root = await open(workspace, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const directory = `/proc/self/fd/${root.fd}/.yolo`;
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('receipt directory is not a local directory');
    const yolo = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const after = await yolo.stat();
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('receipt directory changed during persistence');
      let file;
      try {
        file = await open(`/proc/self/fd/${yolo.fd}/${RECEIPT_NAME}`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
      try {
        await file.writeFile(`${JSON.stringify(receipt)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      return true;
    } finally {
      await yolo.close();
    }
  } finally {
    await root.close();
  }
}
