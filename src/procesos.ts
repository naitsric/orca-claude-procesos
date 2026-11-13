// Lógica pura: de la salida de ps y lsof a una Foto. No toca el sistema, así se prueba en Node
// con texto fijo. El worker (src/sistema.ts) corre los comandos y le pasa lo que imprimen.
import { carpeta, duracion, memoria as fmtMem, puertos as fmtPuertos } from './formato'
import type { Certeza, Foto, Huerfano, Proceso, Rol, Sesion, Totales, Veredicto } from './tipos'

/** Dos lecturas del mismo proceso difieren hasta ~1 s en `inicio` (sale de etime). */
export const TOLERANCIA_MS = 3000
const MAX_COMANDO = 300
const MAX_NOMBRE = 70
const UNA_HORA = 3600_000
const RETENER_SESIONES_MS = 7 * 24 * UNA_HORA

export type Fila = {
  pid: number
  ppid: number
  pgid: number
  uid: number
  tty: string
  inicio: number
  rssKb: number
  cpu: number
  /** Ruta o nombre del ejecutable (`ps -o comm`). */
  comm: string
  comando: string
}

/** Lo que el plugin recuerda entre revisiones, en `storage`. Es lo que permite reconocer a un
 *  huérfano cuando su sesión ya no existe. */
export type Memoria = {
  v: 1
  /** Por clave `pid@inicio`. `termino` es la última vez que se vio viva, si ya murió. */
  sesiones: Record<
    string,
    {
      pid: number
      inicio: number
      pgid: number
      cwd: string | null
      nombre?: string | null
      vista: number
      termino: number | null
    }
  >
  /** Grupos de procesos (pgid) que encabezó una sesión o un shell de Bash: quien siga en el
   *  grupo después de que el líder muere es de esa sesión. */
  grupos: Record<string, { sesion: string; inicio: number }>
  /** Cada descendiente visto bajo una sesión. */
  linaje: Record<string, { inicio: number; sesion: string }>
}

export function memoriaVacia(): Memoria {
  return { v: 1, sesiones: {}, grupos: {}, linaje: {} }
}

export function leerMemoria(valor: unknown): Memoria {
  const m = valor as Partial<Memoria> | null
  if (!m || m.v !== 1 || typeof m.sesiones !== 'object' || typeof m.grupos !== 'object' || typeof m.linaje !== 'object') {
    return memoriaVacia()
  }
  // Copia profunda: armarFoto modifica la memoria que devuelve.
  return JSON.parse(JSON.stringify({ v: 1, sesiones: m.sesiones, grupos: m.grupos, linaje: m.linaje })) as Memoria
}

/** Lo que Claude Code publica de cada proceso en `~/.claude/sessions/<pid>.json`. */
export type InfoClaude = {
  sessionId: string | null
  nombre: string | null
  cwd: string | null
  estado: string | null
  estadoDesde: number | null
  /** Cuándo arrancó el proceso, para no confundirlo con otro que reutilizó el pid. */
  inicio: number | null
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const numeroONull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function leerInfoClaude(json: string): InfoClaude | null {
  let d: Record<string, unknown>
  try {
    d = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (!d || typeof d !== 'object') return null
  // procStart es la hora de inicio del proceso en UTC ("Fri Nov 13 15:59:38 2026"); startedAt, la de la CLI.
  const proc = texto(d.procStart) ? Date.parse(`${d.procStart} GMT`) : NaN
  return {
    sessionId: texto(d.sessionId),
    nombre: texto(d.name),
    cwd: texto(d.cwd),
    estado: texto(d.status),
    estadoDesde: numeroONull(d.statusUpdatedAt) ?? numeroONull(d.updatedAt),
    inicio: Number.isFinite(proc) ? proc : numeroONull(d.startedAt)
  }
}

/** La info vale si arrancó con el proceso: un archivo viejo de un pid reutilizado no. */
function infoDe(info: InfoClaude | undefined, f: Fila): InfoClaude | null {
  if (!info) return null
  if (info.inicio !== null && Math.abs(info.inicio - f.inicio) > 120_000) return null
  return info
}

const mismoInicio = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCIA_MS

export function base(ruta: string): string {
  const limpio = ruta.trim().replace(/\/+$/, '')
  return limpio.slice(limpio.lastIndexOf('/') + 1)
}

// ---------------------------------------------------------------------------------------------
// Lectura de ps y lsof

/** etime de ps: `[[dd-]hh:]mm:ss`. */
export function segundosDeEtime(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return 0
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

// ps -axww -o pid=,ppid=,pgid=,uid=,tty=,etime=,rss=,%cpu=,command=
const LINEA_PS = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/
// ps -ax -o pid=,comm=
const LINEA_COMM = /^\s*(\d+)\s+(.*)$/

export function parsearPs(salidaPs: string, salidaComm: string, ahora: number): Fila[] {
  const comms = new Map<number, string>()
  for (const linea of salidaComm.split('\n')) {
    const m = LINEA_COMM.exec(linea)
    if (m) comms.set(Number(m[1]), m[2].trim())
  }
  const filas: Fila[] = []
  for (const linea of salidaPs.split('\n')) {
    const m = LINEA_PS.exec(linea)
    if (!m) continue
    const pid = Number(m[1])
    const comando = m[9].trim()
    filas.push({
      pid,
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      tty: m[5],
      inicio: ahora - segundosDeEtime(m[6]) * 1000,
      rssKb: Number(m[7]),
      cpu: Number(m[8].replace(',', '.')),
      comm: comms.get(pid) ?? comando.split(/\s+/)[0] ?? '',
      comando
    })
  }
  return filas
}

/** `lsof -F pn`: líneas `p<pid>` seguidas de `n<nombre>`. Devuelve los nombres por pid. */
export function parsearLsof(salida: string): Map<number, string[]> {
  const porPid = new Map<number, string[]>()
  let actual: number | null = null
  for (const linea of salida.split('\n')) {
    if (linea.startsWith('p')) {
      actual = Number(linea.slice(1))
      if (!porPid.has(actual)) porPid.set(actual, [])
    } else if (linea.startsWith('n') && actual !== null) {
      porPid.get(actual)!.push(linea.slice(1))
    }
  }
  return porPid
}

/** De `lsof -iTCP -sTCP:LISTEN -F pn` a los puertos de cada pid, sin repetir. */
export function puertosDeLsof(salida: string): Map<number, number[]> {
  const puertos = new Map<number, number[]>()
  for (const [pid, nombres] of parsearLsof(salida)) {
    const lista = new Set<number>()
    for (const n of nombres) {
      const m = /:(\d+)$/.exec(n)
      if (m) lista.add(Number(m[1]))
    }
    if (lista.size) puertos.set(pid, [...lista].sort((a, b) => a - b))
  }
  return puertos
}

/** De `lsof -a -d cwd -F pn` a la carpeta de cada pid. */
export function cwdsDeLsof(salida: string): Map<number, string> {
  const cwds = new Map<number, string>()
  for (const [pid, nombres] of parsearLsof(salida)) if (nombres[0]) cwds.set(pid, nombres[0])
  return cwds
}

// ---------------------------------------------------------------------------------------------
// Qué es cada proceso

export function esClaude(f: Pick<Fila, 'comm' | 'comando'>): boolean {
  if (base(f.comm) === 'claude') return true
  // Instalaciones por npm: `node …/@anthropic-ai/claude-code/cli.js` o `node …/bin/claude`.
  return /^(\S*\/)?node\s+\S*(@anthropic-ai\/claude-code\/cli\.m?js|\/bin\/claude)(\s|$)/.test(f.comando)
}

export function esShellBash(f: Pick<Fila, 'comando'>): boolean {
  return f.comando.includes('/.claude/shell-snapshots/')
}

function esTunel(f: Fila): boolean {
  return /session-manager-plugin|\bssm\s+start-session|\bssh\b.*\s-[a-zA-Z]*[LRD]\b|\bcloudflared\b|\bngrok\b/.test(f.comando)
}

function esNavegador(f: Fila): boolean {
  return /Google Chrome for Testing|Chromium|chrome-headless-shell|headless_shell|ms-playwright|\/Google Chrome\.app\//.test(f.comando)
}

/** Para huérfanos sin otra pista: un servidor MCP suelto que no es de una app instalada. */
function pareceMcp(f: Fila): boolean {
  if (!/mcp/i.test(f.comando)) return false
  return !/^\/(Applications|System|usr\/(libexec|sbin))\//.test(f.comando) && !f.comando.includes('Application Support/orca')
}

/** Hijos directos de `claude` que no son servidores MCP: los lanza la propia CLI un momento. */
const TRANSITORIOS = new Set(['rg', 'git', 'ps', 'lsof', 'security', 'sw_vers', 'which', 'sh', 'osascript', 'pbcopy', 'pbpaste'])

const ROLES_DE_COMANDO: ReadonlySet<Rol> = new Set(['bash', 'comando', 'servidor', 'tunel'])

function rolDe(f: Fila, padre: Fila | undefined, rolPadre: Rol | null, puertos: readonly number[]): Rol {
  if (esClaude(f)) return 'agente'
  if (esShellBash(f)) return 'bash'
  if (base(f.comm) === 'caffeinate') return 'despierto'
  if (esTunel(f)) return 'tunel'
  if (esNavegador(f)) return 'navegador'
  if (padre && esClaude(padre) && !TRANSITORIOS.has(base(f.comm))) return 'mcp'
  if (rolPadre === 'mcp') return 'mcp'
  if (puertos.length) return 'servidor'
  if (rolPadre && ROLES_DE_COMANDO.has(rolPadre)) return 'comando'
  if (/mcp/i.test(f.comando)) return 'mcp'
  return 'otro'
}

const GENERICOS = new Set(['node', 'python', 'python3', 'uv', 'uvx', 'npm', 'npx', 'pnpm', 'bun', 'deno', 'sh', 'bash', 'zsh', 'ruby', 'java', 'tsx'])
/** Subcomandos de los lanzadores que no dicen qué corre: `uv tool uvx x` es `x`. */
const SUBCOMANDOS = new Set(['tool', 'run', 'exec', 'x', 'uvx', 'dlx', 'start'])
const ARCHIVOS_GENERICOS = /^(index|main|server|cli|app|__main__)\.(m?[jt]s|py)$/

function recortar(texto: string, max: number): string {
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto
}

/** El comando que la herramienta Bash le pasó al shell: `… && eval '<comando>' < /dev/null …`. */
export function comandoDeBash(comando: string): string | null {
  const m = /&& eval '((?:[^']|'\\'')*)'/.exec(comando)
  return m ? m[1].replace(/'\\''/g, "'") : null
}

export function nombreDe(f: Fila, rol: Rol): string {
  if (rol === 'bash') {
    const cmd = comandoDeBash(f.comando)
    return recortar(cmd ? `$ ${cmd.replace(/\s+/g, ' ')}` : 'shell de Bash', MAX_NOMBRE)
  }
  // Un comm con espacios que no es ruta es un título de proceso (`npm exec @playwright/mcp@latest`).
  const titulo = f.comm.includes(' ') && !f.comm.startsWith('/')
  const b = titulo ? f.comm : base(f.comm) || base(f.comando.split(/\s+/)[0] ?? '')
  if (titulo || !GENERICOS.has(b.toLowerCase())) return recortar(b, MAX_NOMBRE)
  // node/python/uv: lo que dice qué es está en los argumentos.
  const args = f.comando.split(/\s+/).slice(1)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-m' && args[i + 1]) return recortar(`${b} -m ${args[i + 1]}`, MAX_NOMBRE)
    if (a === '-c') return `${b} -c`
    if (a.startsWith('-') || SUBCOMANDOS.has(a)) continue
    let pista = base(a)
    if (ARCHIVOS_GENERICOS.test(pista)) {
      const partes = a.split('/').filter(Boolean)
      pista = partes.length > 1 ? `${partes[partes.length - 2]}/${pista}` : pista
    }
    return recortar(`${b} ${pista}`, MAX_NOMBRE)
  }
  return b
}

const ANFITRIONES: ReadonlyArray<[RegExp, string]> = [
  [/Orca Terminal Host|\/Orca\.app\/|orca-tcc-login/, 'Orca'],
  [/ghostty/i, 'Ghostty'],
  [/\/Terminal\.app\//, 'Terminal'],
  [/iTerm/, 'iTerm2'],
  [/\/Claude\.app\//, 'Claude Desktop'],
  [/Visual Studio Code|\/Code Helper/, 'VS Code'],
  [/\/Cursor\.app\//, 'Cursor'],
  [/\/Warp\.app\//, 'Warp'],
  [/wezterm/i, 'WezTerm'],
  [/\btmux\b/, 'tmux']
]

// ---------------------------------------------------------------------------------------------
// Agrupar: a qué sesión pertenece cada proceso

export type Agrupacion = {
  /** Todos los procesos, de todos los usuarios: los ancestros (login es de root) cuentan. */
  porPid: Map<number, Fila>
  hijos: Map<number, number[]>
  uid: number
  /** Sesiones de Claude vivas, las de más afuera (un `claude` dentro de otro es un hijo). */
  raices: { fila: Fila; clave: string }[]
  /** Descendientes y desacoplados de cada sesión viva: pid → clave de la sesión. */
  dueno: Map<number, string>
  desacoplados: Set<number>
  /** Procesos cuya sesión ya no existe (o que solo se parecen a algo de Claude). */
  huerfanos: Map<number, { certeza: Certeza; sesion: string | null }>
  /** Los huérfanos de arriba (cuelgan de launchd), en orden de inicio. */
  topes: number[]
}

function claveDeSesion(memoria: Memoria, f: Fila): string {
  for (const [clave, s] of Object.entries(memoria.sesiones)) {
    if (s.pid === f.pid && mismoInicio(s.inicio, f.inicio)) return clave
  }
  return `${f.pid}@${Math.round(f.inicio / 1000)}`
}

export function agrupar(filas: Fila[], memoria: Memoria, uid: number): Agrupacion {
  const porPid = new Map(filas.map((f) => [f.pid, f]))
  const hijos = new Map<number, number[]>()
  for (const f of filas) {
    if (f.pid === f.ppid || f.pid <= 1) continue
    const lista = hijos.get(f.ppid)
    if (lista) lista.push(f.pid)
    else hijos.set(f.ppid, [f.pid])
  }
  for (const lista of hijos.values()) lista.sort((a, b) => porPid.get(a)!.inicio - porPid.get(b)!.inicio)

  // El `claude` más externo por encima de cada proceso (sin contarlo a él).
  const raizMemo = new Map<number, number | null>()
  const raizDe = (pid: number, profundidad = 0): number | null => {
    if (raizMemo.has(pid)) return raizMemo.get(pid)!
    const f = porPid.get(pid)
    let res: number | null = null
    if (f && f.ppid > 1 && f.ppid !== pid && profundidad < 128) {
      const padre = porPid.get(f.ppid)
      if (padre) res = raizDe(padre.pid, profundidad + 1) ?? (esClaude(padre) ? padre.pid : null)
    }
    raizMemo.set(pid, res)
    return res
  }

  const raices: Agrupacion['raices'] = []
  const clavePorRaiz = new Map<number, string>()
  for (const f of filas) {
    if (f.uid !== uid || !esClaude(f) || raizDe(f.pid) !== null) continue
    const clave = claveDeSesion(memoria, f)
    raices.push({ fila: f, clave })
    clavePorRaiz.set(f.pid, clave)
  }
  raices.sort((a, b) => a.fila.inicio - b.fila.inicio)
  const clavesVivas = new Set(clavePorRaiz.values())

  const dueno = new Map<number, string>()
  for (const f of filas) {
    const raiz = raizDe(f.pid)
    if (raiz !== null && f.uid === uid) dueno.set(f.pid, clavePorRaiz.get(raiz)!)
  }

  /** Descendientes de pid sin entrar en otro `claude` (ese sería su propia sesión). */
  const subarbol = (pid: number): number[] => {
    const res: number[] = []
    const pila = [...(hijos.get(pid) ?? [])].reverse()
    while (pila.length) {
      const p = pila.pop()!
      const f = porPid.get(p)
      if (!f || esClaude(f) || f.uid !== uid) continue
      res.push(p)
      pila.push(...[...(hijos.get(p) ?? [])].reverse())
    }
    return res
  }

  const desacoplados = new Set<number>()
  const huerfanos: Agrupacion['huerfanos'] = new Map()
  const topes: number[] = []
  const candidatos = filas
    .filter((f) => f.ppid === 1 && f.uid === uid && !esClaude(f))
    .sort((a, b) => a.inicio - b.inicio)

  for (const f of candidatos) {
    let sesion: string | null = null
    let certeza: Certeza | null = null
    const lin = memoria.linaje[f.pid]
    const grupo = memoria.grupos[f.pgid]
    const liderVivo = clavePorRaiz.get(f.pgid)
    if (lin && mismoInicio(lin.inicio, f.inicio)) {
      sesion = lin.sesion
      certeza = 'segura'
    } else if (grupo && f.inicio >= grupo.inicio - TOLERANCIA_MS) {
      sesion = grupo.sesion
      certeza = 'segura'
    } else if (liderVivo && f.inicio >= porPid.get(f.pgid)!.inicio - TOLERANCIA_MS) {
      sesion = liderVivo
      certeza = 'segura'
    } else if (esShellBash(f)) {
      certeza = 'segura'
    } else if (pareceMcp(f)) {
      certeza = 'probable'
    }
    if (!certeza) continue

    const todos = [f.pid, ...subarbol(f.pid)]
    if (sesion && clavesVivas.has(sesion)) {
      for (const p of todos) {
        dueno.set(p, sesion)
        desacoplados.add(p)
      }
    } else {
      topes.push(f.pid)
      for (const p of todos) huerfanos.set(p, { certeza, sesion })
    }
  }

  return { porPid, hijos, uid, raices, dueno, desacoplados, huerfanos, topes }
}

/** Para qué pids pedirle a lsof puertos y carpetas. */
export function pidsRelevantes(a: Agrupacion): { puertos: number[]; cwds: number[] } {
  const puertos = new Set<number>([...a.raices.map((r) => r.fila.pid), ...a.dueno.keys(), ...a.huerfanos.keys()])
  const cwds = new Set<number>([...a.raices.map((r) => r.fila.pid), ...a.topes])
  for (const p of a.desacoplados) {
    const f = a.porPid.get(p)
    if (f?.ppid === 1) cwds.add(p)
  }
  return { puertos: [...puertos], cwds: [...cwds] }
}

// ---------------------------------------------------------------------------------------------
// Armar la foto y actualizar la memoria

export type Config = { ahora: number; horasSesionLarga: number; home: string }

const ORDEN: Record<Veredicto, number> = { cerrar: 0, revisar: 1, dejar: 2 }

const ETIQUETA_COMANDO: Partial<Record<Rol, string>> = {
  bash: 'Comando',
  comando: 'Comando',
  servidor: 'Servidor',
  tunel: 'Túnel'
}

function evaluarHijo(
  f: Fila,
  rol: Rol,
  puertos: readonly number[],
  desacoplado: boolean,
  ahora: number
): { veredicto: Veredicto; motivo: string } {
  const enPuerto = puertos.length ? ` Escucha en ${fmtPuertos(puertos)}.` : ''
  if (desacoplado) {
    return { veredicto: 'revisar', motivo: `Se desprendió de la sesión: seguirá vivo cuando la cierres.${enPuerto}` }
  }
  const edad = ahora - f.inicio
  switch (rol) {
    case 'mcp':
      return { veredicto: 'dejar', motivo: `Servidor MCP de esta sesión; se cierra con ella.${enPuerto}` }
    case 'despierto':
      return { veredicto: 'dejar', motivo: 'Evita que el Mac se duerma mientras Claude trabaja.' }
    case 'agente':
      return { veredicto: 'dejar', motivo: 'Otra instancia de Claude lanzada desde esta sesión.' }
    case 'navegador':
      return { veredicto: 'dejar', motivo: 'Navegador que controla esta sesión.' }
    case 'bash':
    case 'comando':
    case 'servidor':
    case 'tunel': {
      const etiqueta = ETIQUETA_COMANDO[rol]!
      if (edad > UNA_HORA) {
        return { veredicto: 'revisar', motivo: `${etiqueta} en segundo plano desde hace ${duracion(edad)}.${enPuerto}` }
      }
      return { veredicto: 'dejar', motivo: `${etiqueta} que Claude está corriendo.${enPuerto}` }
    }
    default:
      return { veredicto: 'dejar', motivo: `Proceso de esta sesión.${enPuerto}` }
  }
}

function anfitrionDe(f: Fila, porPid: Map<number, Fila>): string {
  let actual = porPid.get(f.ppid)
  for (let i = 0; actual && i < 32; i++) {
    for (const [patron, nombre] of ANFITRIONES) if (patron.test(actual.comando) || patron.test(actual.comm)) return nombre
    if (actual.ppid <= 1 || actual.ppid === actual.pid) break
    actual = porPid.get(actual.ppid)
  }
  return f.tty === '??' ? 'Sin terminal' : 'Otra terminal'
}

export function armarFoto(
  a: Agrupacion,
  puertos: Map<number, number[]>,
  cwds: Map<number, string>,
  memoriaPrevia: Memoria,
  config: Config,
  infos: Map<number, InfoClaude> = new Map()
): { foto: Foto; memoria: Memoria } {
  const { ahora } = config
  const memoria = leerMemoria(memoriaPrevia)

  // Roles, recorriendo de padres a hijos.
  const roles = new Map<number, Rol>()
  const rolMemo = (pid: number): Rol | null => {
    if (roles.has(pid)) return roles.get(pid)!
    const f = a.porPid.get(pid)
    if (!f) return null
    if (a.raices.some((r) => r.fila.pid === pid)) {
      roles.set(pid, 'sesion')
      return 'sesion'
    }
    const padre = a.porPid.get(f.ppid)
    const pertenece = (p: number) => a.dueno.has(p) || a.huerfanos.has(p) || a.raices.some((r) => r.fila.pid === p)
    const rolPadre = padre && pertenece(padre.pid) ? rolMemo(padre.pid) : null
    const rol = rolDe(f, padre, rolPadre, puertos.get(pid) ?? [])
    roles.set(pid, rol)
    return rol
  }

  const proceso = (pid: number, nivel: number, desacoplado: boolean): Proceso => {
    const f = a.porPid.get(pid)!
    const rol = rolMemo(pid) ?? 'otro'
    const p = puertos.get(pid) ?? []
    const { veredicto, motivo } = evaluarHijo(f, rol, p, desacoplado, ahora)
    return {
      pid,
      ppid: f.ppid,
      pgid: f.pgid,
      inicio: f.inicio,
      rssKb: f.rssKb,
      cpu: f.cpu,
      nombre: nombreDe(f, rol),
      comando: recortar(f.comando, MAX_COMANDO),
      rol,
      nivel,
      puertos: p,
      veredicto,
      motivo,
      ...(desacoplado ? { desacoplado: true } : {})
    }
  }

  /** Recorre en profundidad, con nivel, solo los pids que cumplan `incluir`. */
  const recorrer = (pid: number, nivel: number, incluir: (p: number) => boolean, salida: number[][]): void => {
    for (const h of a.hijos.get(pid) ?? []) {
      if (!incluir(h)) continue
      salida.push([h, nivel])
      recorrer(h, nivel + 1, incluir, salida)
    }
  }

  // Sesiones.
  const sesiones: Sesion[] = a.raices.map(({ fila: f, clave }) => {
    const filas: number[][] = []
    recorrer(f.pid, 0, (p) => a.dueno.get(p) === clave && !a.desacoplados.has(p), filas)
    const procesos = filas.map(([pid, nivel]) => proceso(pid, nivel, false))
    // Los desacoplados cuelgan de launchd: van al final, cada uno con su subárbol.
    for (const pid of a.desacoplados) {
      if (a.dueno.get(pid) !== clave || a.porPid.get(pid)?.ppid !== 1) continue
      procesos.push(proceso(pid, 0, true))
      const debajo: number[][] = []
      recorrer(pid, 1, (p) => a.desacoplados.has(p), debajo)
      for (const [p, nivel] of debajo) procesos.push(proceso(p, nivel, true))
    }
    const rssTotalKb = f.rssKb + procesos.reduce((n, p) => n + p.rssKb, 0)
    const edad = ahora - f.inicio
    const anfitrion = anfitrionDe(f, a.porPid)
    const info = infoDe(infos.get(f.pid), f)
    const reanuda = /--resume[= ](\S+)/.exec(f.comando)?.[1] ?? null
    const sessionId = info?.sessionId ?? reanuda
    const retomar = sessionId ? ` Se retoma con claude --resume ${sessionId}.` : ''
    const larga = config.horasSesionLarga * UNA_HORA
    let veredicto: Veredicto = 'dejar'
    let motivo: string
    if (f.ppid === 1) {
      veredicto = 'revisar'
      motivo = 'Sesión sin terminal ni proceso padre: quedó sola.'
    } else if (info?.estado) {
      const desde = info.estadoDesde ? ahora - info.estadoDesde : null
      const hace = desde !== null ? ` desde hace ${duracion(desde)}` : ''
      if (info.estado === 'busy') {
        motivo = `Trabajando${hace}.`
      } else if (desde !== null && desde > larga) {
        veredicto = 'revisar'
        motivo = `Inactiva${hace}. Si ya no la usas, ciérrala para liberar ${fmtMem(rssTotalKb)}.${retomar}`
      } else {
        motivo = info.estado === 'idle' ? `Esperando tu mensaje${hace}.` : `Estado «${info.estado}»${hace}.`
      }
    } else if (edad > larga && f.cpu < 2) {
      veredicto = 'revisar'
      motivo = `Abierta hace ${duracion(edad)} y sin actividad ahora. Si ya no la usas, ciérrala para liberar ${fmtMem(rssTotalKb)}.${retomar}`
    } else {
      motivo = f.cpu >= 2 ? `Trabajando (CPU ${Math.round(f.cpu)} %).` : 'Sesión abierta.'
    }
    return {
      pid: f.pid,
      inicio: f.inicio,
      nombre: info?.nombre ?? null,
      sessionId,
      estado: info?.estado ?? null,
      estadoDesde: info?.estadoDesde ?? null,
      rssKb: f.rssKb,
      rssTotalKb,
      cpu: f.cpu,
      tty: f.tty,
      cwd: cwds.get(f.pid) ?? info?.cwd ?? memoria.sesiones[clave]?.cwd ?? null,
      anfitrion,
      reanuda,
      comando: recortar(f.comando, MAX_COMANDO),
      procesos,
      veredicto,
      motivo
    }
  })
  sesiones.sort((x, y) => ORDEN[x.veredicto] - ORDEN[y.veredicto] || y.rssTotalKb - x.rssTotalKb)

  // Huérfanos.
  const huerfanos: Huerfano[] = []
  for (const tope of a.topes) {
    const info = a.huerfanos.get(tope)!
    const s = info.sesion ? memoria.sesiones[info.sesion] : undefined
    const origen = s ? { pid: s.pid, nombre: s.nombre ?? null, cwd: s.cwd, termino: s.termino ?? s.vista } : null
    const filas: number[][] = [[tope, 0]]
    recorrer(tope, 1, (p) => a.huerfanos.has(p), filas)
    for (const [pid, nivel] of filas) {
      const fila = proceso(pid, nivel, false)
      const p = fila.puertos
      const enPuerto = p.length ? ` Ocupa ${fmtPuertos(p)}.` : ''
      let veredicto: Veredicto
      let motivo: string
      if (info.certeza === 'probable') {
        veredicto = 'revisar'
        motivo = `Parece un servidor MCP sin dueño. Puede ser de otra app (Cursor, Claude Desktop…); revísalo antes de cerrarlo.${enPuerto}`
      } else if (nivel > 0) {
        veredicto = 'cerrar'
        motivo = `Hijo de un proceso huérfano de Claude.${enPuerto}`
      } else if (origen) {
        veredicto = 'cerrar'
        const donde = origen.nombre ? ` «${origen.nombre}»` : origen.cwd ? ` en ${carpeta(origen.cwd, config.home)}` : ''
        const cuando = origen.termino ? ` hace ${duracion(ahora - origen.termino)}` : ''
        motivo = `Su sesión de Claude${donde} terminó${cuando} y este proceso siguió vivo.${enPuerto}`
      } else {
        veredicto = 'cerrar'
        motivo = `Shell de Bash de una sesión de Claude que ya no existe.${enPuerto}`
      }
      huerfanos.push({
        ...fila,
        veredicto,
        motivo,
        certeza: info.certeza,
        cwd: cwds.get(pid) ?? null,
        origen
      })
    }
  }

  // Memoria: sesiones vivas, las que murieron, grupos y linaje.
  const vivas = new Set<string>()
  for (const { fila: f, clave } of a.raices) {
    vivas.add(clave)
    const previa = memoria.sesiones[clave]
    const info = infoDe(infos.get(f.pid), f)
    memoria.sesiones[clave] = {
      pid: f.pid,
      inicio: previa?.inicio ?? f.inicio,
      pgid: f.pgid,
      cwd: cwds.get(f.pid) ?? info?.cwd ?? previa?.cwd ?? null,
      nombre: info?.nombre ?? previa?.nombre ?? null,
      vista: ahora,
      termino: null
    }
    if (f.pgid === f.pid) memoria.grupos[String(f.pid)] = { sesion: clave, inicio: previa?.inicio ?? f.inicio }
  }
  for (const [clave, s] of Object.entries(memoria.sesiones)) {
    if (vivas.has(clave)) continue
    if (s.termino === null) s.termino = s.vista
    if (ahora - s.termino > RETENER_SESIONES_MS) delete memoria.sesiones[clave]
  }
  for (const [pid, clave] of a.dueno) {
    const f = a.porPid.get(pid)!
    const previo = memoria.linaje[String(pid)]
    memoria.linaje[String(pid)] = {
      inicio: previo && mismoInicio(previo.inicio, f.inicio) ? previo.inicio : f.inicio,
      sesion: clave
    }
    if (f.pgid === f.pid) memoria.grupos[String(pid)] = { sesion: clave, inicio: f.inicio }
  }
  for (const [pid, l] of Object.entries(memoria.linaje)) {
    const f = a.porPid.get(Number(pid))
    if (!f || !mismoInicio(f.inicio, l.inicio) || !memoria.sesiones[l.sesion]) delete memoria.linaje[pid]
  }
  const pgidsVivos = new Set<number>()
  for (const f of a.porPid.values()) pgidsVivos.add(f.pgid)
  for (const [pgid, g] of Object.entries(memoria.grupos)) {
    const lider = a.porPid.get(Number(pgid))
    const otroLider = lider && !mismoInicio(lider.inicio, g.inicio)
    if (!memoria.sesiones[g.sesion] || !pgidsVivos.has(Number(pgid)) || otroLider) delete memoria.grupos[pgid]
  }

  const procesosSesiones = sesiones.reduce((n, s) => n + 1 + s.procesos.length, 0)
  const totales: Totales = {
    sesiones: sesiones.length,
    procesos: procesosSesiones + huerfanos.length,
    rssKb: sesiones.reduce((n, s) => n + s.rssTotalKb, 0) + huerfanos.reduce((n, h) => n + h.rssKb, 0),
    huerfanos: huerfanos.length,
    huerfanosSeguros: huerfanos.filter((h) => h.certeza === 'segura').length,
    huerfanosRssKb: huerfanos.reduce((n, h) => n + h.rssKb, 0),
    puertosHuerfanos: [...new Set(huerfanos.flatMap((h) => h.puertos))].sort((x, y) => x - y)
  }

  return { foto: { tomadaEn: ahora, home: config.home, sesiones, huerfanos, totales }, memoria }
}

/** Todo lo que la foto deja cerrar, por pid, con su `inicio` para validar la identidad. */
export function cerrables(foto: Foto): Map<number, { inicio: number; nombre: string }> {
  const mapa = new Map<number, { inicio: number; nombre: string }>()
  for (const s of foto.sesiones) {
    mapa.set(s.pid, { inicio: s.inicio, nombre: `claude (${s.nombre ?? carpeta(s.cwd, foto.home)})` })
    for (const p of s.procesos) mapa.set(p.pid, { inicio: p.inicio, nombre: p.nombre })
  }
  for (const h of foto.huerfanos) mapa.set(h.pid, { inicio: h.inicio, nombre: h.nombre })
  return mapa
}

export function mismoProceso(a: number, b: number): boolean {
  return mismoInicio(a, b)
}
