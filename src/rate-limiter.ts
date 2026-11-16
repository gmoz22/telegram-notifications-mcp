export class RateLimitError extends Error {
  constructor(retryAfterSeconds: number) {
    super(`Client send limit reached; retry in about ${retryAfterSeconds} seconds.`);
    this.name = "RateLimitError";
  }
}

export class RateLimiter {
  private readonly nextTargetSend = new Map<string, number>();
  private readonly clientSends = new Map<string, number[]>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async wait(clientName: string, targetName: string): Promise<void> {
    let unlock!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;

    let scheduledAt: number | undefined;
    try {
      const currentTime = this.now();
      const recentSends = (this.clientSends.get(clientName) ?? [])
        .filter((timestamp) => timestamp > currentTime - 60_000);
      if (recentSends.length >= 30) {
        const retryAt = recentSends[recentSends.length - 30] + 60_000;
        throw new RateLimitError(Math.max(1, Math.ceil((retryAt - currentTime) / 1000)));
      }

      scheduledAt = Math.max(currentTime, this.nextTargetSend.get(targetName) ?? currentTime);
      this.nextTargetSend.set(targetName, scheduledAt + 1_000);
      recentSends.push(scheduledAt);
      this.clientSends.set(clientName, recentSends);
    } finally {
      unlock();
    }

    if (scheduledAt === undefined) {
      return;
    }
    const delay = scheduledAt - this.now();
    if (delay > 0) {
      await this.sleep(delay);
    }
  }
}
