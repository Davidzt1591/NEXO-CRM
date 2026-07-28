const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const KEY_CONTEXT = 'nexo/candidate-quarantine/hmac-sha256/v1';
const DEFAULT_FILE_PATH = path.resolve(__dirname, '../../data/candidate-quarantine.json');

function deriveKey(serviceRoleKey) {
  if (typeof serviceRoleKey !== 'string' || !serviceRoleKey) {
    const error = new Error('SUPABASE_SERVICE_ROLE_KEY is required for durable candidate quarantine.');
    error.code = 'CANDIDATE_QUARANTINE_KEY_UNAVAILABLE';
    throw error;
  }
  return crypto.hkdfSync('sha256', Buffer.from(serviceRoleKey, 'utf8'), Buffer.alloc(0), Buffer.from(KEY_CONTEXT, 'utf8'), 32);
}

class CandidateQuarantine {
  constructor({ filePath = DEFAULT_FILE_PATH, serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY } = {}) {
    this.filePath = filePath;
    this.serviceRoleKey = serviceRoleKey;
    this.hashes = new Set();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  digest(chatId) {
    const key = deriveKey(this.serviceRoleKey);
    return crypto.createHmac('sha256', key).update(chatId, 'utf8').digest('hex');
  }

  async load() {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!Array.isArray(parsed.hashes) || parsed.hashes.some(value => !/^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Candidate quarantine file has an invalid format.');
      }
      this.hashes = new Set(parsed.hashes);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async has(chatId) {
    const digest = this.digest(chatId);
    await this.load();
    return this.hashes.has(digest);
  }

  async add(chatId) {
    const digest = this.digest(chatId);
    await this.load();
    if (this.hashes.has(digest)) return true;
    this.hashes.add(digest);
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.hashes.delete(digest);
      throw error;
    }
  }

  async remove(chatId) {
    const digest = this.digest(chatId);
    await this.load();
    if (!this.hashes.delete(digest)) return true;
    try {
      await this.persist();
      return true;
    } catch (error) {
      this.hashes.add(digest);
      throw error;
    }
  }

  async persist() {
    const operation = async () => {
      const directory = path.dirname(this.filePath);
      await fs.mkdir(directory, { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const payload = `${JSON.stringify({ version: 1, hashes: [...this.hashes].sort() })}\n`;
      try {
        await fs.writeFile(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    };
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }
}

const candidateQuarantine = new CandidateQuarantine();

module.exports = { CandidateQuarantine, candidateQuarantine, KEY_CONTEXT, DEFAULT_FILE_PATH };
