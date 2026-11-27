// Lo que toca la máquina por los worktrees: corre git y du, y lee fechas de archivos. Como
// src/sistema.ts con los procesos, no decide nada: el veredicto es de src/worktrees.ts.
import { execFile } from 'node:child_process'
import { access, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { t } from './i18n'
import type { ObjetivoWorktree, ResultadoWorktree, Worktree } from './tipos'
import {
  carpetaDeProyecto,
  carpetasCandidatas,
  parsearEstado,
  parsearListaWorktrees,
  validarCierre,
  type EntradaWorktree,
  type LecturaWorktree
} from './worktrees'

/** Cuántos worktrees se leen a la vez: `git status` en un repositorio grande pesa. */
const A_LA_VEZ = 4
/** Cada cuánto se vuelve a medir un worktree que no se movió. */
const TAMANO_VIGENTE_MS = 30 * 60_000
const MAX_HIJOS = 300
const MAX_CONVERSACIONES = 300

type Salida = { ok: boolean; salida: string; error: string }

/** Las lecturas en curso (git status, du): al apagar el plugin se cortan. Quitar un worktree no
 *  está aquí: eso se deja terminar. */
const leyendo = new Set<{ kill(): boolean }>()

export function detenerLecturas(): void {
  for (const hijo of leyendo) hijo.kill()
  leyendo.clear()
}

function ejecutar(comando: string, args: readonly string[], timeout: number, lectura = true): Promise<Salida> {
  return new Promise((resolve) => {
    const hijo = execFile(
      comando,
      args,
      {
        maxBuffer: 16 * 1024 * 1024,
        timeout,
        // Sin tomar el candado del índice: leer no debe estorbarle a una sesión que trabaja ahí,
        // ni cambiar la fecha del índice, que es una de las señales de actividad.
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => {
        leyendo.delete(hijo)
        resolve({ ok: !error, salida: stdout ?? '', error: (stderr || error?.message || '').trim() })
      }
    )
    if (lectura) leyendo.add(hijo)
  })
}

/** `core.fsmonitor` puede nombrar un programa en la configuración del repositorio: no se corre. */
const git = (args: readonly string[], timeout = 30_000, lectura = true): Promise<Salida> =>
  ejecutar('git', ['-c', 'core.fsmonitor=false', ...args], timeout, lectura)

const primeraLinea = (texto: string): string => texto.split('\n')[0].replace(/^(fatal|error): /, '')

const existe = (ruta: string): Promise<boolean> => access(ruta).then(() => true, () => false)

const fecha = (ruta: string): Promise<number> => stat(ruta).then((s) => s.mtimeMs, () => 0)

/** Corre `tarea` sobre cada item, `n` a la vez. Si `seguir` deja de cumplirse no empieza más y
 *  devuelve solo lo que alcanzó a terminar. */
async function porTandas<T, R>(
  items: readonly T[],
  n: number,
  seguir: () => boolean,
  tarea: (item: T) => Promise<R>
): Promise<R[]> {
  const resultados: R[] = []
  let siguiente = 0
  const obrero = async (): Promise<void> => {
    while (siguiente < items.length && seguir()) {
      const i = siguiente++
      resultados[i] = await tarea(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, obrero))
  return resultados.filter((r) => r !== undefined)
}

function carpetaDeClaude(): string {
  return process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`
}

/** La carpeta con `.git` que contiene a `dir`, subiendo. Sin correr git: en un Mac sin las
 *  herramientas de desarrollo, llamarlo abre el instalador. */
async function raizDeRepo(dir: string): Promise<string | null> {
  let actual = dir
  for (let i = 0; i < 40 && actual && actual !== '/'; i++) {
    if (await existe(`${actual}/.git`)) return actual
    actual = actual.slice(0, actual.lastIndexOf('/'))
  }
  return null
}

/** Claude abierto en una carpeta que no es un repositorio trabaja en los de adentro
 *  (`~/www/empresa` con `~/www/empresa/api`): los que tienen `.claude/worktrees`. */
async function reposDeAdentro(dir: string): Promise<string[]> {
  const nombres = (await readdir(dir).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).slice(0, MAX_HIJOS)
  const repos = await Promise.all(
    nombres.map(async (n) => {
      const ruta = `${dir}/${n}`
      return (await existe(`${ruta}/.claude/worktrees`)) && (await existe(`${ruta}/.git`)) ? ruta : null
    })
  )
  return repos.filter((r): r is string => r !== null)
}

/** Dónde guarda git lo propio de un worktree enlazado: lo dice su archivo `.git`. */
async function gitDirDe(ruta: string): Promise<string | null> {
  const contenido = await readFile(`${ruta}/.git`, 'utf8').catch(() => '')
  const m = /^gitdir: (.+)$/m.exec(contenido)
  if (!m) return null
  const dir = m[1].trim()
  return dir.startsWith('/') ? dir : `${ruta}/${dir}`
}

/** La última vez que algo se movió en el worktree: un commit o un cambio de rama (HEAD y su
 *  registro), algo preparado (el índice), un archivo sin confirmar, o una conversación de Claude
 *  que trabajó ahí. */
async function ultimaActividad(ruta: string, sinConfirmar: readonly string[]): Promise<number | null> {
  const gitDir = await gitDirDe(ruta)
  const proyecto = `${carpetaDeClaude()}/projects/${carpetaDeProyecto(ruta)}`
  const conversaciones = (await readdir(proyecto).catch(() => [] as string[]))
    .filter((n) => n.endsWith('.jsonl'))
    .slice(0, MAX_CONVERSACIONES)
  const fechas = await Promise.all(
    [
      ruta,
      ...(gitDir ? [`${gitDir}/HEAD`, `${gitDir}/index`, `${gitDir}/logs/HEAD`] : []),
      ...sinConfirmar.map((r) => `${ruta}/${r}`),
      ...conversaciones.map((n) => `${proyecto}/${n}`)
    ].map(fecha)
  )
  const ultima = Math.max(0, ...fechas)
  return ultima > 0 ? Math.round(ultima) : null
}

/** Lo que mide cada worktree, de una búsqueda a la siguiente: `du` es lo más lento de todo. */
const tamanos = new Map<string, { kb: number; medido: number; actividad: number | null }>()

async function leerUno(repo: string, e: EntradaWorktree): Promise<LecturaWorktree> {
  const lectura: LecturaWorktree = {
    ruta: e.ruta,
    repo,
    head: e.head,
    rama: e.rama,
    bloqueo: e.bloqueo,
    falta: e.falta,
    cambios: 0,
    sinSeguir: 0,
    sinSubir: null,
    commitsSueltos: 0,
    ultimaActividad: null,
    kb: null
  }
  if (e.falta) return lectura
  const estado = await git(['-C', e.ruta, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'])
  if (!estado.ok) return { ...lectura, error: primeraLinea(estado.error) }
  const leido = parsearEstado(estado.salida)
  lectura.cambios = leido.cambios
  lectura.sinSeguir = leido.sinSeguir
  lectura.sinSubir = leido.sinSubir
  if (e.rama === null) {
    // HEAD suelto: los commits a los que no llega ninguna rama se pierden con el worktree.
    const sueltos = await git(['-C', e.ruta, 'rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes', '--tags'])
    lectura.commitsSueltos = sueltos.ok ? Number(sueltos.salida.trim()) || 0 : 0
  }
  lectura.ultimaActividad = await ultimaActividad(e.ruta, leido.rutas)
  const medido = tamanos.get(e.ruta)
  lectura.kb = medido?.kb ?? null
  return lectura
}

/**
 * Todos los worktrees enlazados de los repositorios donde trabajó Claude Code. Parte de las
 * carpetas donde se abrió (`~/.claude.json`) y de las de las sesiones que el plugin conoce.
 * `seguir` la corta entre un repositorio y otro cuando el plugin se apaga.
 */
export async function leerWorktrees(
  sesiones: readonly { cwd: string | null }[],
  seguir: () => boolean = () => true
): Promise<LecturaWorktree[]> {
  const configurado = process.env.CLAUDE_CONFIG_DIR
  const claudeJson = await readFile(configurado ? `${configurado}/.claude.json` : `${homedir()}/.claude.json`, 'utf8').catch(() => null)
  const home = homedir()
  const raices = new Set<string>()
  await Promise.all(
    carpetasCandidatas(claudeJson, sesiones).map(async (dir) => {
      const raiz = await raizDeRepo(dir)
      if (raiz) raices.add(raiz)
      // El home no se recorre: mirar dentro de Documentos o Escritorio pide permiso en macOS.
      else if (dir !== home && dir !== '/') for (const r of await reposDeAdentro(dir)) raices.add(r)
    })
  )

  // Varias raíces pueden ser el mismo repositorio (su carpeta principal y un worktree suyo).
  const repos = new Map<string, EntradaWorktree[]>()
  await porTandas([...raices], A_LA_VEZ, seguir, async (raiz) => {
    const lista = await git(['-C', raiz, 'worktree', 'list', '--porcelain'])
    const entradas = lista.ok ? parsearListaWorktrees(lista.salida) : []
    if (entradas.length > 1) repos.set(entradas[0].ruta, entradas.slice(1).filter((e) => !e.bare))
  })

  const pares = [...repos].flatMap(([repo, entradas]) => entradas.map((e) => ({ repo, e })))
  const lecturas = await porTandas(pares, A_LA_VEZ, seguir, ({ repo, e }) => leerUno(repo, e))
  // A medias no sirve: quien la pidió ya no la quiere.
  if (!seguir()) return []
  for (const ruta of tamanos.keys()) if (!lecturas.some((l) => l.ruta === ruta)) tamanos.delete(ruta)
  return lecturas
}

/** Mide con `du` los worktrees sin medida vigente y la anota en las lecturas. Uno a la vez: es
 *  lento y no hay apuro. Devuelve si alguna medida cambió. */
export async function medirWorktrees(
  lecturas: readonly LecturaWorktree[],
  seguir: () => boolean = () => true,
  ahora = Date.now()
): Promise<boolean> {
  let cambio = false
  for (const l of lecturas) {
    if (!seguir()) break
    if (l.falta) continue
    const previo = tamanos.get(l.ruta)
    if (previo && ahora - previo.medido < TAMANO_VIGENTE_MS && previo.actividad === l.ultimaActividad) continue
    const du = await ejecutar('du', ['-sk', l.ruta], 120_000)
    const kb = Number(/^(\d+)/.exec(du.salida)?.[1] ?? NaN)
    if (!Number.isFinite(kb)) continue
    tamanos.set(l.ruta, { kb, medido: ahora, actividad: l.ultimaActividad })
    if (l.kb !== kb) cambio = true
    l.kb = kb
  }
  return cambio
}

/** Quita un worktree con `git worktree remove`. La rama y sus commits quedan en el repositorio.
 *  Devuelve el error de git, o null si salió bien. */
async function quitar(w: Worktree, forzar: boolean): Promise<string | null> {
  // Solo llega bloqueado el de un subagente cuya sesión ya terminó: ese bloqueo ya no protege nada.
  const bloqueado = w.bloqueo !== null
  if (bloqueado) {
    const libre = await git(['-C', w.repo, 'worktree', 'unlock', w.ruta], 30_000, false)
    if (!libre.ok) return primeraLinea(libre.error)
  }
  const fuera = await git(['-C', w.repo, 'worktree', 'remove', ...(forzar ? ['--force'] : []), w.ruta], 120_000, false)
  if (fuera.ok) {
    tamanos.delete(w.ruta)
    return null
  }
  // No se pudo: queda como estaba, con su bloqueo.
  if (bloqueado) await git(['-C', w.repo, 'worktree', 'lock', ...(w.bloqueo ? ['--reason', w.bloqueo] : []), w.ruta], 30_000, false)
  return primeraLinea(fuera.error)
}

/**
 * Cierra solo lo que está en `actuales`, que el worker acaba de leer: el worktree sigue ahí, en
 * el mismo commit, nadie lo usa y no tiene cambios de los que la confirmación no avisó. Nunca la
 * carpeta principal de un repositorio: `actuales` solo trae worktrees enlazados.
 */
export async function cerrarWorktrees(
  objetivos: readonly ObjetivoWorktree[],
  actuales: readonly Worktree[],
  alTerminar: (resultado: ResultadoWorktree) => void = () => undefined
): Promise<ResultadoWorktree[]> {
  const unicos = objetivos.filter((o, i) => objetivos.findIndex((x) => x.ruta === o.ruta) === i)
  const resultados = new Array<ResultadoWorktree>(unicos.length)
  // Borrar carpetas es lo lento. Cada repositorio va por su cuenta, pero dentro de uno van de a
  // uno: todos escriben en el mismo `.git/worktrees`.
  const colas = new Map<string, (() => Promise<void>)[]>()
  unicos.forEach((o, i) => {
    const anotar = (r: ResultadoWorktree): void => {
      resultados[i] = r
      alTerminar(r)
    }
    const v = validarCierre(o, actuales)
    if ('rechazo' in v) {
      anotar({ ruta: o.ruta, nombre: v.nombre, resultado: 'rechazado', detalle: v.rechazo })
      return
    }
    const { worktree: w, forzar } = v
    const cola = colas.get(w.repo) ?? []
    colas.set(w.repo, cola)
    cola.push(async () => {
      const error = await quitar(w, forzar)
      if (error) anotar({ ruta: o.ruta, nombre: w.nombre, resultado: 'error', detalle: t().worktree.gitFallo(error) })
      else anotar({ ruta: o.ruta, nombre: w.nombre, resultado: 'cerrado' })
    })
  })
  await Promise.all(
    [...colas.values()].map(async (cola) => {
      for (const tarea of cola) await tarea()
    })
  )
  return resultados
}
