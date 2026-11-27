// Qué dice cada confirmación antes de cerrar algo, y cómo se resume el resultado. Puro: lo usan
// los dos paneles («Procesos de Claude» y «Actividad de Claude»), así que preguntan lo mismo y
// cierran lo mismo, y se prueba en Node.
import { carpeta, duracion, memoria, plural, puertos } from './formato'
import { t } from './i18n'
import type {
  Foto,
  Huerfano,
  Objetivo,
  ObjetivoWorktree,
  Proceso,
  ResultadoCierre,
  ResultadoWorktree,
  Rol,
  Senal,
  Sesion,
  Worktree
} from './tipos'
import { objetivoDe } from './worktrees'

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
  /** Si lo que se cierra son worktrees y no procesos: van por `procesos.cerrarWorktrees`. */
  worktrees?: ObjetivoWorktree[]
}

/** `worktrees` trae el resultado cuando lo que se cerró fueron worktrees (y `lista` va vacía). */
export type Hecho = {
  origen: string
  titulo: string
  lista: ResultadoCierre[]
  worktrees?: ResultadoWorktree[]
  /** Cuántos worktrees le faltan a git por borrar: el worker respondió antes de terminar. */
  faltan?: number
  error?: string
}

/** Cómo se llama un tipo de proceso: en singular, o con su número delante. */
function rol(r: Rol, n?: number): string {
  const [uno, varios] = t().roles[r]
  return n === undefined ? uno : plural(n, uno, varios)
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
  const c = t().confirmar
  if (s.estado === 'busy') return c.trabajando
  if (s.estado === 'idle') return c.inactiva(desde)
  if (s.estado) return desde ? `${s.estado} ${desde}` : s.estado
  return c.abiertaHace(duracion(ahora - s.inicio))
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
  return ORDEN_ROLES.flatMap((r) => {
    const grupo = lista.filter((p) => p.rol === r)
    if (!grupo.length) return []
    const enPuerto = todosLosPuertos(grupo)
    return [
      `${rol(r, grupo.length)} · ${memoria(suma(grupo))}` +
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
  if (lista.length > 5) lineas.push(t().confirmar.yMas(lista.length - 5))
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
  const c = t().confirmar
  const notas: Nota[] = []
  if (s.estado === 'busy') notas.push({ texto: c.cortaTarea, tono: 'danger' })
  else if (s.estado === 'idle' && s.estadoDesde) notas.push({ texto: c.inactivaDesde(duracion(ahora - s.estadoDesde)) })
  if (s.sessionId) notas.push({ texto: c.noSePierde(s.sessionId) })
  if (desacoplados.length) notas.push({ texto: c.incluyeDesprendidos(desacoplados.length) })
  if (enPuerto.length) notas.push({ texto: c.libera(puertos(enPuerto)) })
  return {
    origen: `s${s.pid}`,
    titulo: c.cerrarSesionPregunta(nombre),
    tono: s.estado === 'busy' ? 'danger' : 'warning',
    encabezado: c.seCierranConMemoria(1 + s.procesos.length, memoria(s.rssTotalKb)),
    items: [c.laSesion(memoria(s.rssKb)), ...porTipo(s.procesos)],
    notas,
    boton: c.cerrarSesion,
    cancelar: c.mantenerla,
    hecho: c.cerreSesion(nombre),
    objetivos: [objetivo(s), ...desacoplados.filter((p) => p.nivel === 0).map(objetivo)],
    senal: 'TERM',
    arbol: true
  }
}

export function confirmarDeSesion(s: Sesion, elegidos: readonly Proceso[], home: string): Pendiente | null {
  if (!elegidos.length) return null
  const hijos = descendientes(elegidos, s.procesos)
  const c = t().confirmar
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: c.conEllosHijos(hijos.length) })
  if (elegidos.some((p) => p.rol === 'mcp' && !p.desacoplado)) notas.push({ texto: c.pierdeHerramientas, tono: 'warning' })
  if (elegidos.some((p) => ['bash', 'comando', 'servidor', 'tunel'].includes(p.rol) && p.veredicto === 'dejar')) {
    notas.push({ texto: c.esperaComando, tono: 'warning' })
  }
  notas.push({ texto: c.sigueAbierta })
  const n = elegidos.length
  return {
    origen: `s${s.pid}`,
    titulo: c.cerrarDeSesion(n, nombreSesion(s, home)),
    tono: 'warning',
    encabezado: c.seCierran(n),
    items: unoPorUno(elegidos, (p) => rol(p.rol)),
    notas,
    boton: c.cerrarN(n),
    cancelar: c.cancelar,
    hecho: c.cerreN(n + hijos.length),
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
  const c = t().confirmar
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: c.conEllosHijos(hijos.length) })
  if (probables.length < elegidos.length) notas.push({ texto: c.yaTermino })
  if (probables.length) notas.push({ texto: c.otraApp(probables.map((h) => h.nombre).join(', ')), tono: 'warning' })
  if (enPuerto.length) notas.push({ texto: c.libera(puertos(enPuerto)) })
  const n = elegidos.length
  return {
    origen,
    titulo: c.cerrarHuerfanos(n),
    tono: 'warning',
    encabezado: c.seCierran(n),
    items: unoPorUno(elegidos, (p) => {
      const h = p as Huerfano
      if (!h.origen) return h.certeza === 'probable' ? c.origenDudoso : c.sesionInexistente
      return c.deSesion(h.origen.nombre ?? carpeta(h.origen.cwd, home))
    }),
    notas,
    boton: c.cerrarN(n),
    cancelar: c.cancelar,
    hecho: c.cerreN(n + hijos.length),
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
  const c = t().confirmar
  return {
    origen,
    titulo: c.forzarPregunta(lista.length),
    tono: 'danger',
    encabezado: c.noRespondieron,
    items: lista.map((r) => `${r.nombre} · pid ${r.pid}`),
    notas: [{ texto: c.sigkill, tono: 'warning' }],
    boton: c.forzar,
    cancelar: c.dejarlos,
    hecho: c.forzado(lista.length),
    objetivos: lista.map((r) => ({ pid: r.pid, inicio: inicios.get(r.pid)! })),
    senal: 'KILL',
    arbol: false
  }
}

// ---------------------------------------------------------------------------------------------
// Worktrees

/** `repo/nombre`: dos repositorios pueden tener un worktree con el mismo nombre. */
export function nombreWorktree(w: Pick<Worktree, 'repo' | 'nombre'>): string {
  return `${carpeta(w.repo)}/${w.nombre}`
}

/** Los que se pueden cerrar de una: sin actividad reciente y sin nada que perder. */
export function worktreesParaCerrar(f: Foto): Worktree[] {
  return f.worktrees.filter((w) => w.veredicto === 'cerrar' && w.cerrable)
}

export function confirmarWorktrees(origen: string, elegidos: readonly Worktree[], ahora: number): Pendiente | null {
  const lista = elegidos.filter((w) => w.cerrable)
  if (!lista.length) return null
  const c = t().confirmar
  const n = lista.length
  const disco = lista.reduce((kb, w) => kb + (w.kb ?? 0), 0)
  const nombres = (ws: readonly Worktree[]): string => ws.map((w) => w.nombre).join(', ')
  const conCambios = lista.filter((w) => w.cambios + w.sinSeguir > 0)
  const conSueltos = lista.filter((w) => w.commitsSueltos > 0)
  const recientes = lista.filter((w) => w.veredicto === 'dejar')
  const notas: Nota[] = []
  if (conCambios.length) notas.push({ texto: c.descartaCambios(conCambios.length, nombres(conCambios)), tono: 'danger' })
  if (conSueltos.length) notas.push({ texto: c.pierdeCommits(nombres(conSueltos)), tono: 'danger' })
  if (recientes.length) notas.push({ texto: c.conActividad(recientes.length, nombres(recientes)), tono: 'warning' })
  if (lista.some((w) => w.rama)) notas.push({ texto: c.ramasQuedan(lista.filter((w) => w.rama).length) })
  if (lista.some((w) => !w.falta)) notas.push({ texto: c.carpetaSeBorra(lista.filter((w) => !w.falta).length) })
  const items = lista.slice(0, 5).map((w) =>
    [
      nombreWorktree(w),
      w.rama ?? t().worktree.headSuelto,
      w.falta ? c.soloRegistro : w.ultimaActividad !== null ? c.sinActividad(duracion(ahora - w.ultimaActividad)) : null,
      w.kb !== null ? memoria(w.kb) : null
    ]
      .filter(Boolean)
      .join(' · ')
  )
  if (n > 5) items.push(c.yMas(n - 5))
  return {
    origen,
    titulo: c.cerrarWorktrees(n),
    tono: conCambios.length || conSueltos.length ? 'danger' : 'warning',
    encabezado: c.seCierranWorktrees(disco ? memoria(disco) : ''),
    items,
    notas,
    boton: c.cerrarWorktreesN(n),
    cancelar: c.cancelar,
    hecho: c.cerreWorktrees(n),
    objetivos: [],
    senal: 'TERM',
    arbol: false,
    worktrees: lista.map(objetivoDe)
  }
}

/** Cómo se cuenta un resultado: título, si salió todo bien, las líneas y los que siguen vivos. */
export function resumirHecho(h: Hecho): { titulo: string; todoBien: boolean; lineas: string[]; vivos: ResultadoCierre[] } {
  if (h.worktrees) {
    const c = t().confirmar
    const cerrados = h.worktrees.filter((r) => r.resultado === 'cerrado')
    const fallidos = h.worktrees.filter((r) => r.resultado !== 'cerrado')
    const todoBien = !h.error && !fallidos.length
    return {
      titulo: h.error
        ? c.noSePudo
        : h.faltan
          ? c.sigueCerrando(h.faltan)
          : todoBien
            ? h.titulo
            : c.cerreWorktreesDe(cerrados.length, h.worktrees.length),
      todoBien: todoBien && !h.faltan,
      lineas: [
        ...(h.faltan ? [c.tardaEnBorrar] : []),
        ...(h.error ? [c.workerNoRespondio(h.error)] : []),
        ...fallidos.map((r) => `${r.nombre}: ${r.detalle ?? r.resultado}`)
      ],
      vivos: []
    }
  }
  const cerrados = h.lista.filter((r) => r.resultado === 'cerrado')
  const vivos = h.lista.filter((r) => r.resultado === 'sigue-vivo')
  const fallidos = h.lista.filter((r) => r.resultado === 'rechazado' || r.resultado === 'error')
  const todoBien = !h.error && !vivos.length && !fallidos.length
  const c = t().confirmar
  const titulo = h.error ? c.noSePudo : todoBien ? h.titulo : c.cerreDe(cerrados.length, h.lista.length)
  const lineas: string[] = []
  if (h.error) lineas.push(c.workerNoRespondio(h.error))
  if (todoBien && cerrados.length > 1) lineas.push(c.cerrados(cerrados.length))
  if (vivos.length) lineas.push(c.siguenVivos(vivos.map((r) => `${r.nombre} (${r.pid})`).join(', ')))
  for (const r of fallidos) lineas.push(`${r.nombre} (${r.pid}): ${r.detalle ?? r.resultado}`)
  return { titulo, todoBien, lineas, vivos }
}
