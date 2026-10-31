import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const COMMENT_MAX_LENGTH = 2000;

/**
 * Comments left in the movie and series popups, shared by every account.
 * Stored as { [itemKey]: [{ id, username, text, createdAt }] }, oldest first; itemKey is
 * `movie:<id>` or `show:<key>`, so a show's comments survive episodes being added or removed.
 */
export function createCommentsStore(filePath) {
  let lock = Promise.resolve();

  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  };

  const write = async (data) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(tmp, filePath);
  };

  return {
    async list(itemKey) {
      await lock;
      return (await read())[itemKey] ?? [];
    },

    add(itemKey, username, text) {
      const comment = { id: crypto.randomBytes(8).toString('hex'), username, text, createdAt: new Date().toISOString() };
      const result = lock.then(async () => {
        const data = await read();
        (data[itemKey] ??= []).push(comment);
        await write(data);
        return comment;
      });
      lock = result.catch(() => {});
      return result;
    },
  };
}
