// Tests read many JSON bodies; typing them as `any` keeps assertions short.
declare global {
  interface Response {
    // biome-ignore lint/suspicious/noExplicitAny: test-only convenience
    json(): Promise<any>;
  }
}

export {};
