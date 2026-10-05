export class KinlockError extends Error {
  override name = "KinlockError";
}

/** Thrown by scaffolded functions that are not built yet. */
export class NotImplementedError extends KinlockError {
  override name = "NotImplementedError";
  constructor(what: string, roadmapRow: string) {
    super(`${what} is not implemented yet (roadmap ${roadmapRow})`);
  }
}
