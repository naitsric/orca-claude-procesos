// Lo poco de Node que usa el worker. Las typings de Orca no traen @types/node y el plugin no
// tiene node_modules; esto alcanza para que `npx tsc -p .` revise src/sistema.ts y src/git.ts.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { maxBuffer?: number; timeout?: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): { kill(signal?: string): boolean }
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readdir(path: string): Promise<string[]>
  export function readlink(path: string): Promise<string>
  export function access(path: string): Promise<void>
  export function stat(path: string): Promise<{ mtimeMs: number }>
  // Solo para src/git.test.ts, que arma un repositorio de verdad en una carpeta temporal.
  export function mkdtemp(prefix: string): Promise<string>
  export function mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  export function writeFile(path: string, data: string): Promise<void>
  export function rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
  export function realpath(path: string): Promise<string>
  // Solo para src/worker.test.ts, que le pone fecha vieja a un worktree de prueba.
  export function utimes(path: string, atime: Date, mtime: Date): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
  export function tmpdir(): string
}

declare const process: {
  readonly pid: number
  readonly ppid: number
  readonly env: Record<string, string | undefined>
  readonly platform: string
  getuid(): number
  kill(pid: number, signal?: string | number): boolean
}
