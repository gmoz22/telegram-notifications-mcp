export class RateLimitError extends Error {
    constructor(retryAfterSeconds) {
        super(`Client send limit reached; retry in about ${retryAfterSeconds} seconds.`);
        this.name = "RateLimitError";
    }
}
export class RateLimiter {
    now;
    sleep;
    nextTargetSend = new Map();
    clientSends = new Map();
    queue = Promise.resolve();
    constructor(now = Date.now, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
        this.now = now;
        this.sleep = sleep;
    }
    async wait(clientName, targetName) {
        let unlock;
        const previous = this.queue;
        this.queue = new Promise((resolve) => {
            unlock = resolve;
        });
        await previous;
        let scheduledAt;
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
        }
        finally {
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
