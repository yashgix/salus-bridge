// Minimal types for the Node built-ins this project uses, so `tsc --noEmit` works with one pinned package
// (typescript) and no @types/node. Add a declaration here if you use another built-in.
declare const process: {
  argv: string[];
  version: string;
  versions: Record<string, string>;
  platform: string;
  pid: number;
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  exit(code?: number): never;
  cwd(): string;
  hrtime: { bigint(): bigint };
  stdin: NodeReadable;
  stdout: NodeWritable;
  stderr: NodeWritable;
  on(event: "exit" | "SIGINT" | "SIGTERM", listener: (...args: unknown[]) => void): unknown;
};
interface NodeReadable extends AsyncIterable<string | Uint8Array> {
  setEncoding(enc: "utf8"): NodeReadable;
  on(event: "data", listener: (chunk: string | Uint8Array) => void): NodeReadable;
  on(event: "end" | "close", listener: () => void): NodeReadable;
  pause(): NodeReadable;
  resume(): NodeReadable;
}
interface NodeWritable {
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(chunk?: string, cb?: () => void): void;
}

declare module "node:test" {
  type Fn = (t: TestContext) => void | Promise<void>;
  export interface TestContext {
    test(name: string, fn: Fn): Promise<void>;
    after(fn: () => void | Promise<void>): void;
    mock: { timers: { enable(opts?: { apis?: string[]; now?: number }): void; tick(ms: number): void; reset(): void } };
  }
  export function test(name: string, fn: Fn): Promise<void>;
  export function test(name: string, opts: { timeout?: number; skip?: boolean | string }, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: Fn): Promise<void>;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  type ErrorMatch = RegExp | Function | object | ((err: unknown) => boolean);
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, re: RegExp, message?: string): void;
    doesNotMatch(value: string, re: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: ErrorMatch, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: ErrorMatch, message?: string): Promise<void>;
    doesNotReject(p: Promise<unknown> | (() => Promise<unknown>), message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module "node:crypto" {
  interface Hash { update(data: string | Uint8Array): Hash; digest(enc: "hex" | "base64"): string }
  export function createHash(alg: "sha256" | "sha512"): Hash;
  export function randomUUID(): string;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:fs" {
  export function readFileSync(path: string, enc: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  const path: { join: typeof join; resolve: typeof resolve; dirname: typeof dirname; basename: typeof basename };
  export default path;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:readline" {
  interface Interface extends AsyncIterable<string> {
    on(event: "line", listener: (line: string) => void): Interface;
    on(event: "close", listener: () => void): Interface;
    close(): void;
  }
  export function createInterface(opts: { input: NodeReadable; crlfDelay?: number; terminal?: boolean }): Interface;
}

declare module "node:child_process" {
  interface Child {
    stdin: NodeWritable;
    stdout: NodeReadable;
    stderr: NodeReadable;
    pid?: number;
    kill(signal?: string): boolean;
    on(event: "exit" | "close", listener: (code: number | null, signal: string | null) => void): Child;
  }
  export function spawn(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; stdio?: string[] }): Child;
  export function spawnSync(cmd: string, args: string[], opts?: { cwd?: string; encoding?: "utf8"; timeout?: number; input?: string }):
    { status: number | null; stdout: string; stderr: string; error?: Error };
}

declare module "node:timers/promises" {
  export function setTimeout<T = void>(ms: number, value?: T, opts?: { signal?: AbortSignal }): Promise<T>;
}
