// La única parte que toca la máquina: corre ps y lsof, y manda señales. El resto es src/procesos.ts.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  agrupar,
  armarFoto,
  cerrables,
  cwdsDeLsof,
  leerInfoClaude,
  mismoProceso,
  parsearPs,
  pidsRelevantes,
  puertosDeLsof,
  type InfoClaude,
  type Memoria
} from './procesos'
import type { Foto, Objetivo, ResultadoCierre, Senal } from './tipos'

export type Opciones = { horasSesionLarga: number }

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
          else reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
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

export async function tomarFoto(memoria: Memoria, opciones: Opciones): Promise<{ foto: Foto; memoria: Memoria }> {
  const ahora = Date.now()
  const [ps, comm] = await Promise.all([
    correr('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,tty=,etime=,rss=,%cpu=,command=']),
    correr('/bin/ps', ['-ax', '-o', 'pid=,comm='])
  ])
  const agrupacion = agrupar(parsearPs(ps, comm, ahora), memoria, process.getuid())
  const relevantes = pidsRelevantes(agrupacion)
  const [escuchando, carpetas, infos] = await Promise.all([
    relevantes.puertos.length
      ? correr('/usr/sbin/lsof', ['-nP', '-a', '-p', relevantes.puertos.join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn'])
      : Promise.resolve(''),
    relevantes.cwds.length
      ? correr('/usr/sbin/lsof', ['-nP', '-a', '-p', relevantes.cwds.join(','), '-d', 'cwd', '-F', 'pn'])
      : Promise.resolve(''),
    infosDeClaude(agrupacion.raices.map((r) => r.fila.pid))
  ])
  return armarFoto(agrupacion, puertosDeLsof(escuchando), cwdsDeLsof(carpetas), memoria, {
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
