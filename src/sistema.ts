// La única parte que toca la máquina: corre ps (y lsof en macOS; en Linux lee /proc) y manda
// señales. El resto es src/procesos.ts.
import { execFile } from 'node:child_process'
import { access, readdir, readFile, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  agrupar,
  COLUMNAS_PS,
  armarFoto,
  cerrables,
  cpuReciente,
  cpuSegDeStat,
  cwdsDeLsof,
  escuchasDeProcNet,
  leerInfoClaude,
  mismoProceso,
  parsearPs,
  pidsRelevantes,
  puertosDeLsof,
  puertosDeSockets,
  type CpuLeida,
  type Fila,
  type InfoClaude,
  type Memoria
} from './procesos'
import type { Foto, Objetivo, ResultadoCierre, Senal } from './tipos'

export type Opciones = { horasSesionLarga: number }

const LINUX = process.platform === 'linux'

/** Corre un comando y devuelve su salida. lsof sale con 1 si algún pid ya no existe: si imprimió
 *  algo, eso vale. */
function correr(comando: string, args: readonly string[], timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      comando,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error && (typeof error.code !== 'number' || !stdout)) {
          if (typeof error.code === 'number') resolve('')
          else if (error.code === 'ENOENT') reject(new Error(`No encontré ${comando}${LINUX ? ' (viene en el paquete procps)' : ''}.`))
          else reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

const existe = (ruta: string): Promise<boolean> => access(ruta).then(() => true, () => false)

let rutaPs: string | null = null

/** macOS siempre lo tiene en /bin. En Linux casi siempre está en /usr/bin o /bin; si no (NixOS),
 *  el del PATH. */
async function ps(): Promise<string> {
  if (!rutaPs) {
    rutaPs = '/bin/ps'
    if (LINUX) rutaPs = (await existe('/usr/bin/ps')) ? '/usr/bin/ps' : (await existe('/bin/ps')) ? '/bin/ps' : 'ps'
  }
  return rutaPs
}

let ticks: Promise<number> | null = null

/** Las unidades de /proc/<pid>/stat. Es 100 en todas las arquitecturas comunes, pero se pregunta. */
function ticksPorSegundo(): Promise<number> {
  ticks ??= correr('getconf', ['CLK_TCK'], 2000)
    .then((s) => Number(s.trim()))
    .then((n) => (Number.isFinite(n) && n > 0 ? n : 100), () => 100)
  return ticks
}

/** Las lecturas de CPU anteriores, para que el %CPU de Linux sea el reciente y no el de toda la
 *  vida del proceso. Las comparten las muestras y las revisiones completas. */
let cpuLeida: CpuLeida = new Map()

/** Linux: el tiempo de CPU de los procesos del usuario con centésimas, de /proc. ps solo da
 *  segundos enteros y con eso la CPU entre dos muestras de 5 s salta de a 20 %. */
async function cpuDeProc(filas: Fila[], yo: number): Promise<void> {
  const hz = await ticksPorSegundo()
  await Promise.all(
    filas
      .filter((f) => f.uid === yo)
      .map(async (f) => {
        const stat = await readFile(`/proc/${f.pid}/stat`, 'utf8').catch(() => null)
        const seg = stat ? cpuSegDeStat(stat, hz) : null
        if (seg !== null) f.cpuSeg = seg
      })
  )
}

/** Linux, en vez de `lsof -iTCP -sTCP:LISTEN`: los sockets en escucha de /proc/net y, de cada
 *  pid, cuáles de sus descriptores son esos sockets. */
async function puertosDeProc(pids: readonly number[]): Promise<Map<number, number[]>> {
  if (!pids.length) return new Map()
  const tablas = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((r) => readFile(r, 'utf8').catch(() => '')))
  const escuchas = escuchasDeProcNet(...tablas)
  if (!escuchas.size) return new Map()
  const fds = new Map<number, string[]>()
  await Promise.all(
    pids.map(async (pid) => {
      const dir = `/proc/${pid}/fd`
      const nombres = await readdir(dir).catch(() => [] as string[])
      const destinos = await Promise.all(nombres.map((n) => readlink(`${dir}/${n}`).catch(() => '')))
      fds.set(pid, destinos.filter((d) => d.startsWith('socket:')))
    })
  )
  return puertosDeSockets(fds, escuchas)
}

/** Linux, en vez de `lsof -d cwd`: el enlace /proc/<pid>/cwd. */
async function cwdsDeProc(pids: readonly number[]): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  await Promise.all(
    pids.map(async (pid) => {
      const ruta = await readlink(`/proc/${pid}/cwd`).catch(() => null)
      if (ruta) cwds.set(pid, ruta.replace(/ \(deleted\)$/, ''))
    })
  )
  return cwds
}

/** Claude Code escribe `<config>/sessions/<pid>.json` con el nombre, el id y el estado de cada
 *  sesión. Si falta (versiones viejas) se sigue sin él. */
async function infosDeClaude(pids: readonly number[]): Promise<Map<number, InfoClaude>> {
  const dir = `${process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`}/sessions`
  const infos = new Map<number, InfoClaude>()
  await Promise.all(
    pids.map(async (pid) => {
      const json = await readFile(`${dir}/${pid}.json`, 'utf8').catch(() => null)
      const info = json ? leerInfoClaude(json) : null
      if (info) infos.set(pid, info)
    })
  )
  return infos
}

/** Todos los procesos de la máquina, con `ps`. Lo usan la revisión completa y las muestras. */
export async function leerFilas(ahora: number): Promise<Fila[]> {
  if (!LINUX) {
    const [salida, comm] = await Promise.all([
      correr('/bin/ps', ['-axww', '-o', COLUMNAS_PS]),
      correr('/bin/ps', ['-ax', '-o', 'pid=,comm='])
    ])
    return parsearPs(salida, comm, ahora)
  }
  const bin = await ps()
  const [salida, comm] = await Promise.all([
    correr(bin, ['-e', '-ww', '-o', COLUMNAS_PS]),
    correr(bin, ['-e', '-o', 'pid=,comm='])
  ])
  const filas = parsearPs(salida, comm, ahora, 'linux')
  await cpuDeProc(filas, process.getuid())
  cpuLeida = cpuReciente(filas, cpuLeida, ahora)
  return filas
}

export const uid = (): number => process.getuid()

async function puertosConLsof(pids: readonly number[]): Promise<Map<number, number[]>> {
  if (!pids.length) return new Map()
  return puertosDeLsof(await correr('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']))
}

async function cwdsConLsof(pids: readonly number[]): Promise<Map<number, string>> {
  if (!pids.length) return new Map()
  return cwdsDeLsof(await correr('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn']))
}

export async function tomarFoto(memoria: Memoria, opciones: Opciones): Promise<{ foto: Foto; memoria: Memoria }> {
  const ahora = Date.now()
  const agrupacion = agrupar(await leerFilas(ahora), memoria, process.getuid())
  const relevantes = pidsRelevantes(agrupacion)
  const [puertos, cwds, infos] = await Promise.all([
    LINUX ? puertosDeProc(relevantes.puertos) : puertosConLsof(relevantes.puertos),
    LINUX ? cwdsDeProc(relevantes.cwds) : cwdsConLsof(relevantes.cwds),
    infosDeClaude(agrupacion.raices.map((r) => r.fila.pid))
  ])
  return armarFoto(agrupacion, puertos, cwds, memoria, {
    ahora,
    horasSesionLarga: opciones.horasSesionLarga,
    home: homedir()
  }, infos)
}

function vivo(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

async function esperar(pids: readonly number[], ms: number): Promise<void> {
  const limite = Date.now() + ms
  while (Date.now() < limite && pids.some(vivo)) await new Promise((r) => setTimeout(r, 150))
}

/**
 * Cierra solo lo que está en una foto tomada ahora mismo, con el mismo `inicio`: así no se mata
 * un pid que el sistema le dio a otro proceso ni algo que no sea de Claude. Con `arbol`, primero
 * avisa a los objetivos (una sesión cierra sus MCP sola) y después a los descendientes que sigan.
 */
export async function cerrar(
  objetivos: readonly Objetivo[],
  senal: Senal,
  arbol: boolean,
  memoria: Memoria,
  opciones: Opciones
): Promise<{ resultados: ResultadoCierre[]; foto: Foto; memoria: Memoria }> {
  const antes = await tomarFoto(memoria, opciones)
  const permitidos = cerrables(antes.foto)
  const protegidos = new Set([0, 1, process.pid, process.ppid])
  const resultados: ResultadoCierre[] = []
  const primera: number[] = []
  for (const o of objetivos) {
    const info = permitidos.get(o.pid)
    if (protegidos.has(o.pid) || !info) {
      resultados.push({
        pid: o.pid,
        nombre: info?.nombre ?? `pid ${o.pid}`,
        resultado: 'rechazado',
        detalle: 'Ya no aparece como proceso de Claude.'
      })
    } else if (!mismoProceso(info.inicio, o.inicio)) {
      resultados.push({ pid: o.pid, nombre: info.nombre, resultado: 'rechazado', detalle: 'Ese pid ya es de otro proceso.' })
    } else if (!primera.includes(o.pid)) {
      primera.push(o.pid)
    }
  }

  const segunda: number[] = []
  if (arbol) {
    const hijos = new Map<number, number[]>()
    for (const p of [...antes.foto.sesiones.flatMap((s) => s.procesos), ...antes.foto.huerfanos]) {
      hijos.set(p.ppid, [...(hijos.get(p.ppid) ?? []), p.pid])
    }
    const pila = [...primera]
    while (pila.length) {
      for (const h of hijos.get(pila.pop()!) ?? []) {
        if (primera.includes(h) || segunda.includes(h) || protegidos.has(h)) continue
        segunda.push(h)
        pila.push(h)
      }
    }
  }

  const nombreSenal = senal === 'KILL' ? 'SIGKILL' : 'SIGTERM'
  const errores = new Map<number, string>()
  const enviar = (pid: number): void => {
    try {
      process.kill(pid, nombreSenal)
    } catch (error) {
      const e = error as { code?: string; message?: string }
      if (e.code !== 'ESRCH') errores.set(pid, e.message ?? String(error))
    }
  }
  primera.forEach(enviar)
  if (segunda.length) {
    await esperar(primera, 1500)
    segunda.filter(vivo).forEach(enviar)
  }
  const todos = [...primera, ...segunda]
  await esperar(todos, 3000)
  for (const pid of todos) {
    const nombre = permitidos.get(pid)?.nombre ?? `pid ${pid}`
    if (errores.has(pid)) resultados.push({ pid, nombre, resultado: 'error', detalle: errores.get(pid) })
    else resultados.push({ pid, nombre, resultado: vivo(pid) ? 'sigue-vivo' : 'cerrado' })
  }

  const despues = await tomarFoto(antes.memoria, opciones)
  return { resultados, ...despues }
}
