'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Small atomic JSON store. A corrupt file is preserved for debugging and
 * replaced with defaults rather than preventing the launcher from starting.
 */
class JsonStore {
  constructor(filePath, defaults) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = clone(defaults);
    this.existed = false;
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Store must contain a JSON object');
      }
      this.data = { ...clone(this.defaults), ...parsed };
      this.existed = true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.data = clone(this.defaults);
        await this.save();
      } else {
        try {
          await fsp.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
        } catch {
          /* ignore */
        }
        this.data = clone(this.defaults);
        await this.save();
      }
    }
    this.loaded = true;
    return this.data;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      await fsp.rename(temp, this.filePath);
    } catch {
      await fsp.rm(this.filePath, { force: true });
      await fsp.rename(temp, this.filePath);
    }
  }
}

module.exports = { JsonStore };
