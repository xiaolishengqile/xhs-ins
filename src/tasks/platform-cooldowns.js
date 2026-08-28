export class PlatformCooldowns {
  constructor({ store, now, isPaused, onReady }) {
    this.store = store;
    this.now = now;
    this.isPaused = isPaused;
    this.onReady = onReady;
    this.untilByPlatform = new Map();
    this.timer = null;
  }

  async init() {
    const state = await this.store.load();
    const timestamp = this.now().getTime();
    for (const [platform, until] of Object.entries(state.cooldowns ?? {})) {
      if (Date.parse(until) > timestamp) this.untilByPlatform.set(platform, until);
    }
    this.#armTimer();
    return state.paused === true;
  }

  has(platform) {
    return this.untilByPlatform.has(platform);
  }

  values() {
    return Object.fromEntries(this.untilByPlatform);
  }

  refresh() {
    this.#removeExpired();
    this.#armTimer();
  }

  async set(platform, milliseconds) {
    const until = new Date(this.now().getTime() + milliseconds).toISOString();
    const previous = this.untilByPlatform.get(platform);
    this.untilByPlatform.set(platform, until);
    try {
      await this.save();
    } catch (error) {
      if (previous) this.untilByPlatform.set(platform, previous);
      else this.untilByPlatform.delete(platform);
      this.#armTimer();
      throw error;
    }
    this.#armTimer();
  }

  save(paused = this.isPaused()) {
    return this.store.save({
      paused,
      updatedAt: this.now().toISOString(),
      cooldowns: this.values(),
    });
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  #removeExpired() {
    const timestamp = this.now().getTime();
    for (const [platform, until] of this.untilByPlatform) {
      if (Date.parse(until) <= timestamp) this.untilByPlatform.delete(platform);
    }
  }

  #armTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.untilByPlatform.size === 0) return;
    const earliest = Math.min(...[...this.untilByPlatform.values()].map(Date.parse));
    this.timer = setTimeout(async () => {
      this.timer = null;
      this.#removeExpired();
      await this.save().catch(() => {});
      this.onReady();
    }, Math.max(0, earliest - this.now().getTime()));
  }
}
