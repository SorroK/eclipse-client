'use strict';

const crypto = require('crypto');
const { safeStorage } = require('electron');
const { offlineUuid } = require('../core/utils');

const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

function sanitizeAccount(account) {
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    uuid: account.uuid,
  };
}

function friendlyAuthError(error) {
  const raw = String((error && error.message) || error || '');
  if (raw.includes('error.gui.closed')) return 'Microsoft sign-in was cancelled.';
  if (raw.includes('error.state.invalid.http')) return 'Could not start the Microsoft sign-in server.';
  if (raw.includes('error.auth.minecraft')) {
    return 'This Microsoft account does not own Minecraft: Java Edition, or access was denied.';
  }
  if (/invalid_grant|invalid refresh|AADSTS/i.test(raw)) {
    return 'Your Microsoft session has expired. Sign in with Microsoft again.';
  }
  if (/network|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(raw)) {
    return 'Could not reach Microsoft. Check your internet connection and try again.';
  }
  return raw || 'Microsoft sign-in failed. Please try again.';
}

class AccountManager {
  constructor(options) {
    this.store = options.store;
    this.log = options.log || (() => {});
    this.signingIn = false;
    this.warnedAboutEncryption = false;
    this.data = null;
  }

  async init() {
    const data = await this.store.load();
    this.data = data;
    if (!Array.isArray(this.data.profiles)) this.data.profiles = [];
    for (const profile of this.data.profiles) {
      if (profile.type === 'offline' && (!profile.uuid || !profile.id)) {
        profile.uuid = offlineUuid(profile.name);
        profile.id = profile.id || `offline-${crypto.randomUUID()}`;
      }
    }

    let changed = false;
    if (!this.store.existed && this.data.profiles.length === 0) {
      this.data.profiles.push(this.createOfflineRecord('Player'));
      changed = true;
    }
    if (!this.data.selectedId || !this.getAccount(this.data.selectedId)) {
      this.data.selectedId = this.data.profiles[0] ? this.data.profiles[0].id : '';
      changed = true;
    }
    if (changed) await this.store.save();
    return this.data;
  }

  getAccount(id) {
    return this.data.profiles.find((profile) => profile.id === id) || null;
  }

  selectedAccount() {
    if (!this.data) return null;
    return this.getAccount(this.data.selectedId) || this.data.profiles[0] || null;
  }

  list() {
    return {
      selectedId: (this.selectedAccount() || {}).id || '',
      profiles: this.data.profiles.map(sanitizeAccount),
    };
  }

  sanitizeById(id) {
    const account = this.getAccount(id);
    return account ? sanitizeAccount(account) : null;
  }

  createOfflineRecord(name) {
    return {
      id: `offline-${crypto.randomUUID()}`,
      type: 'offline',
      name,
      uuid: offlineUuid(name),
      createdAt: new Date().toISOString(),
    };
  }

  assertNameAvailable(name, ignoreId = null) {
    const collision = this.data.profiles.find(
      (profile) => profile.id !== ignoreId && profile.name.toLowerCase() === name.toLowerCase(),
    );
    if (collision) throw new Error(`A profile named "${name}" already exists.`);
  }

  normalizeName(name) {
    const value = String(name || '').trim();
    if (!NAME_PATTERN.test(value)) {
      throw new Error('Usernames must be 3–16 characters and use only letters, numbers, or underscores.');
    }
    return value;
  }

  async addOffline(name) {
    const clean = this.normalizeName(name);
    this.assertNameAvailable(clean);
    const record = this.createOfflineRecord(clean);
    this.data.profiles.push(record);
    this.data.selectedId = record.id;
    await this.store.save();
    return this.list();
  }

  async renameOffline(id, name) {
    const account = this.getAccount(id);
    if (!account) throw new Error('That profile no longer exists.');
    if (account.type !== 'offline') throw new Error('Microsoft profile names are managed by Microsoft.');
    const clean = this.normalizeName(name);
    this.assertNameAvailable(clean, id);
    account.name = clean;
    account.uuid = offlineUuid(clean);
    await this.store.save();
    return this.list();
  }

  async select(id) {
    if (!this.getAccount(id)) throw new Error('That profile no longer exists.');
    this.data.selectedId = id;
    await this.store.save();
    return this.list();
  }

  async remove(id) {
    this.data.profiles = this.data.profiles.filter((profile) => profile.id !== id);
    if (this.data.selectedId === id) {
      this.data.selectedId = this.data.profiles[0] ? this.data.profiles[0].id : '';
    }
    await this.store.save();
    return this.list();
  }

  encryptSecret(value) {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(value).toString('base64')}`;
      }
    } catch {
      /* fall back below */
    }
    if (!this.warnedAboutEncryption) {
      this.warnedAboutEncryption = true;
      this.log('OS-level secret encryption is unavailable; account tokens will use basic encoding.', 'warn');
    }
    return `b64:${Buffer.from(value, 'utf8').toString('base64')}`;
  }

  decryptSecret(value) {
    if (!value || typeof value !== 'string') return null;
    try {
      if (value.startsWith('enc:')) {
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
      }
      if (value.startsWith('b64:')) {
        return Buffer.from(value.slice(4), 'base64').toString('utf8');
      }
    } catch {
      return null;
    }
    return null;
  }

  async signInMicrosoft(parentWindow) {
    if (this.signingIn) throw new Error('A Microsoft sign-in is already in progress.');
    this.signingIn = true;

    try {
      const { Auth } = require('msmc');
      const auth = new Auth('select_account');
      auth.on('load', (code, message) => {
        this.log(`Microsoft sign-in: ${message || code}`, 'debug');
      });

      const parent =
        parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined;
      const xbox = await auth.launch('electron', {
        width: 520,
        height: 700,
        minWidth: 420,
        minHeight: 560,
        parent,
        modal: false,
        resizable: true,
        maximizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#0b0f13',
        title: 'Sign in to Microsoft',
      });

      const minecraft = await xbox.getMinecraft();
      if (!minecraft || !minecraft.profile || !minecraft.profile.id) {
        throw new Error('This Microsoft account is not linked to a Minecraft profile.');
      }
      if (minecraft.isDemo && minecraft.isDemo()) {
        throw new Error('error.auth.minecraft.entitlement');
      }

      const uuid = minecraft.profile.id;
      const name = minecraft.profile.name || 'Minecraft Player';
      const id = `msa-${uuid}`;
      const secret = this.encryptSecret(xbox.save());

      let account = this.getAccount(id) || this.data.profiles.find((profile) => profile.type === 'msa' && profile.uuid === uuid);
      if (account) {
        account.name = name;
        account.uuid = uuid;
        account.secret = secret;
        account.type = 'msa';
      } else {
        account = {
          id,
          type: 'msa',
          name,
          uuid,
          secret,
          createdAt: new Date().toISOString(),
        };
        this.data.profiles.push(account);
      }

      this.data.selectedId = account.id;
      await this.store.save();
      this.log(`Signed in as ${name}.`);
      return sanitizeAccount(account);
    } catch (error) {
      this.log(`Microsoft sign-in failed: ${(error && error.message) || error}`, 'error');
      throw new Error(friendlyAuthError(error));
    } finally {
      this.signingIn = false;
    }
  }

  async credentialsFor(id) {
    const account = this.getAccount(id);
    if (!account) throw new Error('Select a player profile first.');

    if (account.type === 'offline') {
      return {
        name: account.name,
        uuid: account.uuid,
        accessToken: crypto.randomBytes(16).toString('hex'),
        type: 'offline',
        userProperties: '{}',
      };
    }

    const refreshToken = this.decryptSecret(account.secret);
    if (!refreshToken) {
      throw new Error('Your Microsoft session is missing. Sign in with Microsoft again.');
    }

    try {
      const { Auth } = require('msmc');
      const auth = new Auth('select_account');
      const xbox = await auth.refresh(refreshToken);
      const minecraft = await xbox.getMinecraft();
      if (!minecraft || !minecraft.profile || !minecraft.profile.id) {
        throw new Error('This Microsoft account is not linked to a Minecraft profile.');
      }
      if (minecraft.isDemo && minecraft.isDemo()) {
        throw new Error('error.auth.minecraft.entitlement');
      }

      account.name = minecraft.profile.name || account.name;
      account.uuid = minecraft.profile.id;
      account.secret = this.encryptSecret(xbox.save());
      await this.store.save();

      return {
        name: account.name,
        uuid: account.uuid,
        accessToken: minecraft.mcToken,
        xuid: minecraft.xuid || '',
        type: 'msa',
        userProperties: '{}',
      };
    } catch (error) {
      this.log(`Microsoft session refresh failed: ${(error && error.message) || error}`, 'error');
      throw new Error(friendlyAuthError(error));
    }
  }
}

module.exports = { AccountManager };
