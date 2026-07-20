import {
  Collection,
  Guild,
  GuildMember,
  Status,
} from 'discord.js';

const REQUEST_GUILD_MEMBERS_OPCODE = 8;
const DEFAULT_RATE_LIMIT_RETRY_MARGIN_MS = 250;
const DEFAULT_RATE_LIMIT_RETRIES = 1;

interface GuildMemberSnapshotState {
  guild: Guild;
  generation: number;
  completeGeneration: number | null;
  inFlight: {
    generation: number;
    promise: Promise<void>;
  } | null;
}

export interface GuildMemberSnapshotCoordinatorOptions {
  sleep?: (delayMs: number) => Promise<void>;
  rateLimitRetryMarginMs?: number;
  maxRateLimitRetries?: number;
}

export interface GuildMemberSnapshotToken {
  guildId: string;
  generation: number;
}

export interface CompleteGuildMemberSnapshot {
  members: Collection<string, GuildMember>;
  token: GuildMemberSnapshotToken;
}

export class GuildMemberSnapshotUnavailableError extends Error {
  constructor(guildId: string, reason: string) {
    super(`Complete member snapshot for guild ${guildId} is unavailable: ${reason}`);
    this.name = 'GuildMemberSnapshotUnavailableError';
  }
}

/**
 * Discord limits full Request Guild Members (gateway opcode 8) requests to one
 * per guild and bot every 30 seconds. Once one request succeeds, GuildMembers
 * gateway events keep the cache current for the rest of that gateway
 * generation. This coordinator therefore combines concurrent requests and
 * reuses the proven-complete cache until an explicit gateway invalidation.
 */
export class GuildMemberSnapshotCoordinator {
  private readonly states = new Map<string, GuildMemberSnapshotState>();
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly rateLimitRetryMarginMs: number;
  private readonly maxRateLimitRetries: number;

  constructor(options: GuildMemberSnapshotCoordinatorOptions = {}) {
    this.sleep = options.sleep ?? ((delayMs) =>
      new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.rateLimitRetryMarginMs = Math.max(
      0,
      options.rateLimitRetryMarginMs ?? DEFAULT_RATE_LIMIT_RETRY_MARGIN_MS,
    );
    this.maxRateLimitRetries = Math.max(
      0,
      Math.trunc(options.maxRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES),
    );
  }

  async get(guild: Guild): Promise<Collection<string, GuildMember>> {
    return (await this.snapshot(guild)).members;
  }

  async snapshot(guild: Guild): Promise<CompleteGuildMemberSnapshot> {
    const state = this.getState(guild);
    const requestedGeneration = state.generation;
    while (true) {
      if (state.guild !== guild) {
        throw new GuildMemberSnapshotUnavailableError(guild.id, 'guild cache identity changed');
      }
      if (state.generation !== requestedGeneration) {
        throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway generation changed');
      }
      this.assertGuildUsable(guild);

      if (state.completeGeneration === state.generation) {
        return this.result(guild, requestedGeneration);
      }

      if (!state.inFlight) {
        const generation = state.generation;
        const promise = this.fetchGeneration(guild, state, generation)
          .finally(() => {
            if (state.inFlight?.promise === promise) state.inFlight = null;
          });
        state.inFlight = { generation, promise };
      }

      const inFlight = state.inFlight;
      try {
        await inFlight.promise;
      } catch (error) {
        if (state.generation !== requestedGeneration) {
          throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway generation changed');
        }
        // Never overlap opcode-8 requests across gateway generations. A caller
        // that observed an invalidation waits for the stale request to settle,
        // then competes for the one current-generation request below.
        if (inFlight.generation !== state.generation) continue;
        throw error;
      }
      if (inFlight.generation !== state.generation) continue;
      this.assertGenerationCurrent(guild, state, inFlight.generation);
      if (state.completeGeneration !== state.generation) {
        throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway generation changed');
      }
      return this.result(guild, requestedGeneration);
    }
  }

  assertCurrent(
    guild: Guild,
    token: GuildMemberSnapshotToken,
  ): Collection<string, GuildMember> {
    const state = this.states.get(guild.id);
    if (!state || token.guildId !== guild.id || state.guild !== guild ||
        state.generation !== token.generation ||
        state.completeGeneration !== token.generation) {
      throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway generation changed');
    }
    this.assertGuildUsable(guild);
    return guild.members.cache;
  }

  invalidateGuild(guildId: string): void {
    const state = this.states.get(guildId);
    if (!state) return;
    state.generation += 1;
    state.completeGeneration = null;
  }

  invalidateAll(): void {
    for (const guildId of this.states.keys()) this.invalidateGuild(guildId);
  }

  private getState(guild: Guild): GuildMemberSnapshotState {
    const existing = this.states.get(guild.id);
    if (existing) {
      if (existing.guild !== guild) {
        existing.guild = guild;
        existing.generation += 1;
        existing.completeGeneration = null;
      }
      return existing;
    }

    const state: GuildMemberSnapshotState = {
      guild,
      generation: 1,
      completeGeneration: null,
      inFlight: null,
    };
    this.states.set(guild.id, state);
    return state;
  }

  private result(guild: Guild, generation: number): CompleteGuildMemberSnapshot {
    return {
      members: guild.members.cache,
      token: { guildId: guild.id, generation },
    };
  }

  private async fetchGeneration(
    guild: Guild,
    state: GuildMemberSnapshotState,
    generation: number,
  ): Promise<void> {
    let rateLimitRetries = 0;
    while (true) {
      this.assertGenerationCurrent(guild, state, generation);
      try {
        await guild.members.fetch();
        break;
      } catch (error) {
        const retryAfterMs = gatewayMemberRateLimitRetryAfterMs(error);
        if (retryAfterMs === null || rateLimitRetries >= this.maxRateLimitRetries) throw error;
        rateLimitRetries += 1;
        await this.sleep(retryAfterMs + this.rateLimitRetryMarginMs);
      }
    }

    this.assertGenerationCurrent(guild, state, generation);
    state.completeGeneration = generation;
  }

  private assertGenerationCurrent(
    guild: Guild,
    state: GuildMemberSnapshotState,
    generation: number,
  ): void {
    if (this.states.get(guild.id) !== state || state.guild !== guild ||
        state.generation !== generation) {
      throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway generation changed');
    }
    this.assertGuildUsable(guild);
  }

  private assertGuildUsable(guild: Guild): void {
    if (!guild.available) {
      throw new GuildMemberSnapshotUnavailableError(guild.id, 'guild is unavailable');
    }
    if (guild.shard.status !== Status.Ready) {
      throw new GuildMemberSnapshotUnavailableError(guild.id, 'gateway shard is not ready');
    }
  }
}

export function gatewayMemberRateLimitRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    name?: unknown;
    data?: { opcode?: unknown; retry_after?: unknown };
  };
  if (candidate.name !== 'GatewayRateLimitError' ||
      candidate.data?.opcode !== REQUEST_GUILD_MEMBERS_OPCODE) return null;
  const retryAfterSeconds = Number(candidate.data.retry_after);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return null;
  return Math.ceil(retryAfterSeconds * 1_000);
}

const guildMemberSnapshots = new GuildMemberSnapshotCoordinator();

export function getCompleteGuildMembers(
  guild: Guild,
): Promise<Collection<string, GuildMember>> {
  return guildMemberSnapshots.get(guild);
}

export function getCompleteGuildMemberSnapshot(
  guild: Guild,
): Promise<CompleteGuildMemberSnapshot> {
  return guildMemberSnapshots.snapshot(guild);
}

export function assertCompleteGuildMemberSnapshotCurrent(
  guild: Guild,
  token: GuildMemberSnapshotToken,
): Collection<string, GuildMember> {
  return guildMemberSnapshots.assertCurrent(guild, token);
}

export function invalidateCompleteGuildMembers(guildId: string): void {
  guildMemberSnapshots.invalidateGuild(guildId);
}

export function invalidateAllCompleteGuildMembers(): void {
  guildMemberSnapshots.invalidateAll();
}
