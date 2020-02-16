import LRU from 'lru-cache';

export const applyCache = <T extends (...args: any[]) => Promise<any>, K = Parameters<T>>(cache: LRU<any, any>, fn: T, keyFn: (args: K) => string, argsRemappingFn?: (args: K) => K) => {
  const cached = async (...originalArgs: any[]) => {
    let args = [...originalArgs];
    if (argsRemappingFn) {
      args = argsRemappingFn(args as any) as any;
    }

    const key = keyFn(args as any);

    const cachedResult = cache.get(key);
    if (cachedResult) {
      return cachedResult;
    }

    const result = await fn(...args);
    cache.set(key, result);

    return result;
  };

  return cached as any as T;
};
