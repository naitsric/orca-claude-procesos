// Lo poco de Node que usa el worker. Las typings de Orca no traen @types/node y el plugin no
// tiene node_modules; esto alcanza para que `npx tsc -p .` revise src/sistema.ts.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { maxBuffer?: number; timeout?: number; env?: Record<string, string | undefined> },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readdir(path: string): Promise<string[]>
  export function readlink(path: string): Promise<string>
  export function access(path: string): Promise<void>
}

declare module 'node:os' {
  export function homedir(): string
}

declare const process: {
  readonly pid: number
  readonly ppid: number
  readonly env: Record<string, string | undefined>
  readonly platform: string
  getuid(): number
  kill(pid: number, signal?: string | number): boolean
}
