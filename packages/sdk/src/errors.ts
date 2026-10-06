/** Stable, machine-readable error codes; messages are for developers, not end users. */
export type KinlockErrorCode =
  | "NOT_IMPLEMENTED"
  | "INVALID_AMOUNT"
  | "INVALID_REFERENCE"
  | "INVALID_LINK";

export class KinlockError extends Error {
  override name = "KinlockError";
  constructor(
    message: string,
    readonly code: KinlockErrorCode,
  ) {
    super(message);
  }
}

/** Thrown by scaffolded functions that are not built yet. */
export class NotImplementedError extends KinlockError {
  override name = "NotImplementedError";
  constructor(what: string, roadmapRow: string) {
    super(`${what} is not implemented yet (roadmap ${roadmapRow})`, "NOT_IMPLEMENTED");
  }
}
