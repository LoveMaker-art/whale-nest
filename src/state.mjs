import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readState(file, initial) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return structuredClone(initial); }
}

export function writeState(file, value) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  finally { closeSync(fd); }
  renameSync(tmp, file);
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
