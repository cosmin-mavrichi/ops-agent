/** Something that runs async work one piece at a time, in the order it was handed in. */
export type Exclusive = <T>(work: () => Promise<T>) => Promise<T>;

export function createExclusive(): Exclusive {
  // The end of the queue; a failed piece of work must not block the ones after it.
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}
