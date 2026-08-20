export function createSerializedImageTagger(tag: (baseImage: string) => Promise<void>): (baseImage: string) => Promise<void> {
  let tail = Promise.resolve();

  return async (baseImage) => {
    const result = tail.then(() => tag(baseImage));
    tail = result.then(() => undefined, () => undefined);
    return await result;
  };
}
