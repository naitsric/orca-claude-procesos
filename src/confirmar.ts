// Qué dice cada confirmación antes de cerrar algo, y cómo se resume el resultado. Puro: lo usan
// los dos paneles («Procesos de Claude» y «Actividad de Claude»), así que preguntan lo mismo y
// cierran lo mismo, y se prueba en Node.
import { carpeta, duracion, memoria, plural, puertos } from './formato'
import type { Foto, Huerfano, Objetivo, Proceso, ResultadoCierre, Rol, Senal, Sesion } from './tipos'

export type Tono = 'warning' | 'danger'

export type Nota = { texto: string; tono?: Tono }

/** Una acción esperando confirmación. Todo lo que muestra se arma al pedirla. */
export type Pendiente = {
  /** Dónde se pidió: ahí mismo sale la confirmación y después el resultado. */
  origen: string
  titulo: string
  tono: Tono
  /** Encabezado de la lista: "Se cierran 7 procesos (284 MB):". */
  encabezado: string
  items: string[]
  notas: Nota[]
  boton: string
  cancelar: string
  /** Cómo se titula el resultado si todo sale bien. */
  hecho: string
  objetivos: Objetivo[]
  senal: Senal
  arbol: boolean
}

export type Hecho = { origen: string; titulo: string; lista: ResultadoCierre[]; error?: string }

export const ROL: Record<Rol, [string, string]> = {
  sesion: ['sesión de Claude', 'sesiones de Claude'],
  mcp: ['servidor MCP', 'servidores MCP'],
  bash: ['comando de Bash', 'comandos de Bash'],
  comando: ['proceso de un comando', 'procesos de comandos'],
  servidor: ['servidor', 'servidores'],
  tunel: ['túnel', 'túneles'],
  navegador: ['proceso del navegador', 'procesos del navegador'],
  despierto: ['caffeinate', 'caffeinate'],
  agente: ['otra sesión de Claude', 'otras sesiones de Claude'],
  otro: ['otro proceso', 'otros procesos']
}

const ORDEN_ROLES: readonly Rol[] = ['agente', 'mcp', 'bash', 'comando', 'servidor', 'tunel', 'navegador', 'despierto', 'otro']

function objetivo(p: { pid: number; inicio: number }): Objetivo {
  return { pid: p.pid, inicio: p.inicio }
}

export function nombreSesion(s: Sesion, home: string): string {
  return s.nombre ?? carpeta(s.cwd, home)
}

export function estadoCorto(s: Sesion, ahora: number): string {
  const desde = s.estadoDesde ? duracion(ahora - s.estadoDesde) : null
  if (s.estado === 'busy') return 'trabajando'
  if (s.estado === 'idle') return desde ? `inactiva ${desde}` : 'inactiva'
  if (s.estado) return desde ? `${s.estado} ${desde}` : s.estado
  return `abierta ${duracion(ahora - s.inicio)}`
}

/** Si la sesión o alguno de sus procesos tiene algo que revisar (lleva ⚠). */
export function tieneAviso(s: Sesion): boolean {
  return s.veredicto !== 'dejar' || s.procesos.some((p) => p.veredicto !== 'dejar')
}

/** Los huérfanos que se pueden cerrar de una: su sesión terminó seguro, y sin contar a sus hijos. */
export function huerfanosSeguros(f: Foto): Huerfano[] {
  return f.huerfanos.filter((h) => h.certeza === 'segura' && h.nivel === 0)
}

const suma = (lista: readonly { rssKb: number }[]): number => lista.reduce((n, p) => n + p.rssKb, 0)

const todosLosPuertos = (lista: readonly { puertos: number[] }[]): number[] =>
  [...new Set(lista.flatMap((p) => p.puertos))].sort((a, b) => a - b)

/** "6 servidores MCP · 160 MB", una línea por tipo de proceso. */
function porTipo(lista: readonly Proceso[]): string[] {
  return ORDEN_ROLES.flatMap((rol) => {
    const grupo = lista.filter((p) => p.rol === rol)
    if (!grupo.length) return []
    const enPuerto = todosLosPuertos(grupo)
    return [
      `${plural(grupo.length, ROL[rol][0], ROL[rol][1])} · ${memoria(suma(grupo))}` +
        (enPuerto.length ? ` · ${puertos(enPuerto)}` : '')
    ]
  })
}

/** Una línea por proceso, como mucho 5. */
function unoPorUno(lista: readonly (Proceso | Huerfano)[], detalle: (p: Proceso | Huerfano) => string): string[] {
  const lineas = lista.slice(0, 5).map((p) => {
    const extra = detalle(p)
    return `${p.nombre}${extra ? ` · ${extra}` : ''} · ${memoria(p.rssKb)}` + (p.puertos.length ? ` · ${puertos(p.puertos)}` : '')
  })
  if (lista.length > 5) lineas.push(`y ${lista.length - 5} más`)
  return lineas
}

/** Los descendientes de `raices` dentro de `todos`, sin repetir las raíces. */
function descendientes<T extends { pid: number; ppid: number }>(raices: readonly T[], todos: readonly T[]): T[] {
  const elegidos = new Set(raices.map((p) => p.pid))
  const res: T[] = []
  let frontera = new Set(elegidos)
  while (frontera.size) {
    const siguiente = new Set<number>()
    for (const p of todos) {
      if (frontera.has(p.ppid) && !elegidos.has(p.pid)) {
        elegidos.add(p.pid)
        res.push(p)
        siguiente.add(p.pid)
      }
    }
    frontera = siguiente
  }
  return res
}

export function confirmarSesion(s: Sesion, home: string, ahora: number): Pendiente {
  const nombre = nombreSesion(s, home)
  const desacoplados = s.procesos.filter((p) => p.desacoplado)
  const enPuerto = todosLosPuertos(s.procesos)
  const notas: Nota[] = []
  if (s.estado === 'busy') notas.push({ texto: 'Está trabajando ahora: la tarea en curso se corta.', tono: 'danger' })
  else if (s.estado === 'idle' && s.estadoDesde) notas.push({ texto: `Está inactiva desde hace ${duracion(ahora - s.estadoDesde)}.` })
  if (s.sessionId) notas.push({ texto: `La conversación no se pierde: la retomas con claude --resume ${s.sessionId}` })
  if (desacoplados.length) {
    notas.push({ texto: `Incluye ${plural(desacoplados.length, 'proceso que se había desprendido', 'procesos que se habían desprendido')} de la sesión.` })
  }
  if (enPuerto.length) notas.push({ texto: `Libera ${puertos(enPuerto)}.` })
  return {
    origen: `s${s.pid}`,
    titulo: `¿Cerrar la sesión «${nombre}»?`,
    tono: s.estado === 'busy' ? 'danger' : 'warning',
    encabezado: `Se cierran ${plural(1 + s.procesos.length, 'proceso', 'procesos')} (${memoria(s.rssTotalKb)}):`,
    items: [`claude, la sesión · ${memoria(s.rssKb)}`, ...porTipo(s.procesos)],
    notas,
    boton: 'Cerrar sesión',
    cancelar: 'Mantenerla abierta',
    hecho: `Cerré la sesión «${nombre}»`,
    objetivos: [objetivo(s), ...desacoplados.filter((p) => p.nivel === 0).map(objetivo)],
    senal: 'TERM',
    arbol: true
  }
}

export function confirmarDeSesion(s: Sesion, elegidos: readonly Proceso[], home: string): Pendiente | null {
  if (!elegidos.length) return null
  const hijos = descendientes(elegidos, s.procesos)
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: `Con ellos se ${hijos.length === 1 ? 'cierra' : 'cierran'} ${plural(hijos.length, 'proceso hijo', 'procesos hijos')}.` })
  if (elegidos.some((p) => p.rol === 'mcp' && !p.desacoplado)) {
    notas.push({ texto: 'La sesión pierde las herramientas de esos servidores MCP hasta que la reinicies.', tono: 'warning' })
  }
  if (elegidos.some((p) => ['bash', 'comando', 'servidor', 'tunel'].includes(p.rol) && p.veredicto === 'dejar')) {
    notas.push({ texto: 'Claude puede estar esperando a que ese comando termine; lo verá fallar.', tono: 'warning' })
  }
  notas.push({ texto: 'La sesión sigue abierta.' })
  const n = elegidos.length
  return {
    origen: `s${s.pid}`,
    titulo: `¿Cerrar ${plural(n, 'proceso', 'procesos')} de «${nombreSesion(s, home)}»?`,
    tono: 'warning',
    encabezado: `Se ${n === 1 ? 'cierra' : 'cierran'}:`,
    items: unoPorUno(elegidos, (p) => ROL[p.rol][0]),
    notas,
    boton: `Cerrar ${plural(n, 'proceso', 'procesos')}`,
    cancelar: 'Cancelar',
    hecho: `Cerré ${plural(n + hijos.length, 'proceso', 'procesos')}`,
    objetivos: elegidos.map(objetivo),
    senal: 'TERM',
    arbol: true
  }
}

export function confirmarHuerfanos(
  origen: string,
  elegidos: readonly Huerfano[],
  todos: readonly Huerfano[],
  home: string
): Pendiente | null {
  if (!elegidos.length) return null
  const hijos = descendientes(elegidos, todos)
  const probables = elegidos.filter((h) => h.certeza === 'probable')
  const enPuerto = todosLosPuertos([...elegidos, ...hijos])
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: `Con ellos se ${hijos.length === 1 ? 'cierra' : 'cierran'} ${plural(hijos.length, 'proceso hijo', 'procesos hijos')}.` })
  if (probables.length < elegidos.length) notas.push({ texto: 'Su sesión de Claude ya terminó: nadie los está usando.' })
  if (probables.length) {
    notas.push({
      texto: `${probables.map((h) => h.nombre).join(', ')} podría ser de otra app (Cursor, Claude Desktop…).`,
      tono: 'warning'
    })
  }
  if (enPuerto.length) notas.push({ texto: `Libera ${puertos(enPuerto)}.` })
  const n = elegidos.length
  return {
    origen,
    titulo: `¿Cerrar ${plural(n, 'proceso huérfano', 'procesos huérfanos')}?`,
    tono: 'warning',
    encabezado: `Se ${n === 1 ? 'cierra' : 'cierran'}:`,
    items: unoPorUno(elegidos, (p) => {
      const h = p as Huerfano
      if (!h.origen) return h.certeza === 'probable' ? 'origen dudoso' : 'de una sesión que ya no existe'
      return `de «${h.origen.nombre ?? carpeta(h.origen.cwd, home)}»`
    }),
    notas,
    boton: `Cerrar ${plural(n, 'proceso', 'procesos')}`,
    cancelar: 'Cancelar',
    hecho: `Cerré ${plural(n + hijos.length, 'proceso', 'procesos')}`,
    objetivos: elegidos.map(objetivo),
    senal: 'TERM',
    arbol: true
  }
}

export function confirmarForzar(origen: string, vivos: readonly ResultadoCierre[], f: Foto | null): Pendiente | null {
  if (!f) return null
  const inicios = new Map<number, number>()
  for (const s of f.sesiones) {
    inicios.set(s.pid, s.inicio)
    for (const p of s.procesos) inicios.set(p.pid, p.inicio)
  }
  for (const h of f.huerfanos) inicios.set(h.pid, h.inicio)
  const lista = vivos.filter((r) => inicios.has(r.pid))
  if (!lista.length) return null
  return {
    origen,
    titulo: `¿Forzar el cierre de ${plural(lista.length, 'proceso', 'procesos')}?`,
    tono: 'danger',
    encabezado: 'No respondieron al cierre normal:',
    items: lista.map((r) => `${r.nombre} · pid ${r.pid}`),
    notas: [{ texto: 'Forzar (SIGKILL) los termina en el acto, sin dejarles guardar nada.', tono: 'warning' }],
    boton: 'Forzar cierre',
    cancelar: 'Dejarlos así',
    hecho: `Forcé el cierre de ${plural(lista.length, 'proceso', 'procesos')}`,
    objetivos: lista.map((r) => ({ pid: r.pid, inicio: inicios.get(r.pid)! })),
    senal: 'KILL',
    arbol: false
  }
}

/** Cómo se cuenta un resultado: título, si salió todo bien, las líneas y los que siguen vivos. */
export function resumirHecho(h: Hecho): { titulo: string; todoBien: boolean; lineas: string[]; vivos: ResultadoCierre[] } {
  const cerrados = h.lista.filter((r) => r.resultado === 'cerrado')
  const vivos = h.lista.filter((r) => r.resultado === 'sigue-vivo')
  const fallidos = h.lista.filter((r) => r.resultado === 'rechazado' || r.resultado === 'error')
  const todoBien = !h.error && !vivos.length && !fallidos.length
  const titulo = h.error
    ? 'No se pudo cerrar'
    : todoBien
      ? h.titulo
      : `Cerré ${cerrados.length} de ${plural(h.lista.length, 'proceso', 'procesos')}`
  const lineas: string[] = []
  if (h.error) lineas.push(`El worker no respondió: ${h.error}`)
  if (todoBien && cerrados.length > 1) lineas.push(`${plural(cerrados.length, 'proceso cerrado', 'procesos cerrados')}.`)
  if (vivos.length) lineas.push(`Siguen vivos: ${vivos.map((r) => `${r.nombre} (${r.pid})`).join(', ')}.`)
  for (const r of fallidos) lineas.push(`${r.nombre} (${r.pid}): ${r.detalle ?? r.resultado}`)
  return { titulo, todoBien, lineas, vivos }
}
