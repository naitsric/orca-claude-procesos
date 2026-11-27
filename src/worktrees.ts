// Lógica pura de los worktrees: de la salida de git a un veredicto. Claude Code abre worktrees
// (`claude --worktree`, la herramienta EnterWorktree, los subagentes aislados) y muchos se quedan
// ahí cuando la sesión termina. No toca el sistema: src/git.ts corre git y le pasa lo que obtiene.
// Los motivos salen en el idioma actual (./i18n).
import { carpeta, duracion } from './formato'
import { t } from './i18n'
import type { Foto, ObjetivoWorktree, OrigenWorktree, Veredicto, Worktree } from './tipos'

const UN_DIA = 24 * 3600_000
/** La hora del bloqueo de un subagente no dice su zona: se acepta cualquiera. */
const HOLGURA_BLOQUEO_MS = 26 * 3600_000
/** Cuántos worktrees viajan en una foto: Orca no deja publicar más de 256 KiB, y cada uno pesa
 *  medio KB. Van primero los que se proponen cerrar; los totales cuentan todos. */
export const MAX_WORKTREES_EN_FOTO = 200

// ---------------------------------------------------------------------------------------------
// Lectura de git

/** Un bloque de `git worktree list --porcelain`. */
export type EntradaWorktree = {
  ruta: string
  head: string
  /** null con HEAD suelto (o en un repositorio bare). */
  rama: string | null
  /** El motivo de `git worktree lock`; '' si se bloqueó sin motivo. null si no está bloqueado. */
  bloqueo: string | null
  /** Git lo marca `prunable`: su carpeta ya no existe. */
  falta: boolean
  bare: boolean
}

/** `git worktree list --porcelain`: el primer bloque es la carpeta principal del repositorio. */
export function parsearListaWorktrees(salida: string): EntradaWorktree[] {
  const entradas: EntradaWorktree[] = []
  let actual: EntradaWorktree | null = null
  for (const linea of salida.split('\n')) {
    const corte = linea.indexOf(' ')
    const clave = corte < 0 ? linea : linea.slice(0, corte)
    const valor = corte < 0 ? '' : linea.slice(corte + 1)
    if (clave === 'worktree') {
      actual = { ruta: valor, head: '', rama: null, bloqueo: null, falta: false, bare: false }
      entradas.push(actual)
    } else if (!actual) {
      continue
    } else if (clave === 'HEAD') {
      actual.head = valor
    } else if (clave === 'branch') {
      actual.rama = valor.replace(/^refs\/heads\//, '')
    } else if (clave === 'bare') {
      actual.bare = true
    } else if (clave === 'locked') {
      // Un motivo con caracteres raros llega entre comillas.
      actual.bloqueo = valor.replace(/^"(.*)"$/, '$1')
    } else if (clave === 'prunable') {
      actual.falta = true
    }
  }
  return entradas
}

/** Lo que dice `git status` de un worktree. */
export type EstadoGit = {
  /** Commits sin subir. null si la rama no tiene upstream. */
  sinSubir: number | null
  /** Archivos seguidos con cambios sin confirmar. */
  cambios: number
  /** Archivos y carpetas sin seguir (los ignorados no cuentan). */
  sinSeguir: number
  /** Las rutas de unos y otros, relativas al worktree: su fecha dice cuándo se tocó por última vez. */
  rutas: string[]
}

/** Cuántos campos van antes de la ruta en cada tipo de línea de `--porcelain=v2`. */
const CAMPOS_ANTES: Record<string, number> = { '1': 8, '2': 9, u: 10 }

/** `git status --porcelain=v2 --branch -z`: entradas separadas por NUL. */
export function parsearEstado(salida: string, maxRutas = 50): EstadoGit {
  const estado: EstadoGit = { sinSubir: null, cambios: 0, sinSeguir: 0, rutas: [] }
  const partes = salida.split('\0')
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i]
    if (!p) continue
    const tipo = p[0]
    let ruta: string | null = null
    if (tipo === '#') {
      const m = /^# branch\.ab \+(\d+) -\d+$/.exec(p)
      if (m) estado.sinSubir = Number(m[1])
      continue
    } else if (tipo === '?') {
      estado.sinSeguir++
      ruta = p.slice(2)
    } else if (CAMPOS_ANTES[tipo] !== undefined && p[1] === ' ') {
      estado.cambios++
      ruta = p.split(' ').slice(CAMPOS_ANTES[tipo]).join(' ')
      // Un renombre trae después la ruta de origen, como otra entrada.
      if (tipo === '2') i++
    }
    if (ruta && estado.rutas.length < maxRutas) estado.rutas.push(ruta.replace(/\/$/, ''))
  }
  return estado
}

/** El bloqueo que Claude Code le pone al worktree de un subagente:
 *  `claude agent agent-a1b2 (pid 4129 start Wed Sep 30 16:19:24 2026)`. */
export function agenteDeBloqueo(motivo: string | null): { id: string; pid: number; inicio: number | null } | null {
  const m = /^claude agent (\S+) \(pid (\d+)(?: start ([^)]+))?\)/.exec(motivo ?? '')
  if (!m) return null
  const inicio = m[3] ? Date.parse(`${m[3]} GMT`) : NaN
  return { id: m[1], pid: Number(m[2]), inicio: Number.isFinite(inicio) ? inicio : null }
}

export function origenDe(ruta: string, bloqueo: string | null): OrigenWorktree {
  if (agenteDeBloqueo(bloqueo)) return 'agente'
  const m = /\/\.claude\/worktrees\/([^/]+)$/.exec(ruta)
  if (m) return m[1].startsWith('agent-') ? 'agente' : 'claude'
  // Orca guarda sus workspaces en ~/orca/workspaces/<proyecto>/<nombre>.
  if (/\/orca\/workspaces\//.test(ruta)) return 'orca'
  return 'otro'
}

/** Las carpetas donde se abrió Claude Code: las claves de `projects` en `~/.claude.json`. */
export function carpetasDeClaude(json: string): string[] {
  try {
    const d = JSON.parse(json) as { projects?: unknown }
    if (!d || typeof d.projects !== 'object' || !d.projects) return []
    return Object.keys(d.projects).filter((ruta) => ruta.startsWith('/'))
  } catch {
    return []
  }
}

/** Cómo se llama la carpeta de `~/.claude/projects/` que guarda las conversaciones de una ruta. */
export function carpetaDeProyecto(ruta: string): string {
  return ruta.replace(/[^a-zA-Z0-9]/g, '-')
}

const dentro = (ruta: string | null | undefined, de: string): boolean => !!ruta && (ruta === de || ruta.startsWith(`${de}/`))

// ---------------------------------------------------------------------------------------------
// El veredicto

/** Lo que src/git.ts leyó de un worktree enlazado. */
export type LecturaWorktree = {
  ruta: string
  repo: string
  head: string
  rama: string | null
  bloqueo: string | null
  falta: boolean
  cambios: number
  sinSeguir: number
  sinSubir: number | null
  commitsSueltos: number
  ultimaActividad: number | null
  kb: number | null
  /** `git status` falló: no se sabe qué tiene. */
  error?: string
}

export type ConfigWorktrees = { ahora: number; diasInactivo: number; home: string }

type Vivos = Pick<Foto, 'sesiones' | 'huerfanos'>

/** La sesión viva que usa el worktree: trabaja dentro de él, o es la del subagente que lo bloqueó. */
function sesionQueLoUsa(l: LecturaWorktree, vivos: Vivos, home: string): { pid: number; nombre: string; agente: boolean } | null {
  const nombre = (s: Vivos['sesiones'][number]): string => s.nombre ?? carpeta(s.cwd, home)
  const aqui = vivos.sesiones.find((s) => dentro(s.cwd, l.ruta))
  if (aqui) return { pid: aqui.pid, nombre: nombre(aqui), agente: false }
  const agente = agenteDeBloqueo(l.bloqueo)
  if (!agente) return null
  const mismo = (p: { pid: number; inicio: number }): boolean =>
    p.pid === agente.pid && (agente.inicio === null || Math.abs(p.inicio - agente.inicio) < HOLGURA_BLOQUEO_MS)
  // El pid es el del `claude` que lanzó al subagente: una sesión, o un `claude` dentro de otra.
  const duena = vivos.sesiones.find((s) => mismo(s) || s.procesos.some((p) => p.rol === 'agente' && mismo(p)))
  return duena ? { pid: duena.pid, nombre: nombre(duena), agente: true } : null
}

const ORDEN: Record<Veredicto, number> = { cerrar: 0, revisar: 1, dejar: 2 }

export function evaluarWorktree(l: LecturaWorktree, vivos: Vivos, config: ConfigWorktrees): Worktree {
  const m = t().worktree
  const origen = origenDe(l.ruta, l.bloqueo)
  const sesion = l.falta ? null : sesionQueLoUsa(l, vivos, config.home)
  const pendientes = l.cambios + l.sinSeguir
  const hace = l.ultimaActividad === null ? null : duracion(Math.max(0, config.ahora - l.ultimaActividad))
  const inactivo = l.ultimaActividad !== null && config.ahora - l.ultimaActividad >= config.diasInactivo * UN_DIA
  const huerfano = l.falta ? undefined : vivos.huerfanos.find((h) => h.nivel === 0 && dentro(h.cwd, l.ruta))

  let veredicto: Veredicto = 'dejar'
  let cerrable = true
  let motivo: string
  if (l.bloqueo !== null && !agenteDeBloqueo(l.bloqueo)) {
    // Lo bloqueó alguien a mano (un disco externo, por ejemplo): no se toca.
    cerrable = false
    motivo = m.bloqueado(l.bloqueo)
  } else if (l.falta) {
    veredicto = 'cerrar'
    motivo = m.falta
  } else if (sesion) {
    cerrable = false
    motivo = sesion.agente ? m.enUsoAgente(t().cita(sesion.nombre)) : m.enUso(t().cita(sesion.nombre))
  } else if (huerfano) {
    veredicto = 'revisar'
    cerrable = false
    motivo = m.conHuerfano(huerfano.nombre)
  } else if (l.error) {
    veredicto = 'revisar'
    cerrable = false
    motivo = m.sinLeer(l.error)
  } else if (origen === 'orca') {
    cerrable = false
    veredicto = inactivo ? 'revisar' : 'dejar'
    motivo = inactivo ? m.orcaInactivo(hace!) : m.orca
  } else if (hace === null) {
    veredicto = 'revisar'
    motivo = m.sinFecha
  } else if (!inactivo) {
    motivo = m.activo(hace)
  } else {
    const deAgente = origen === 'agente' ? m.deAgente : ''
    if (pendientes) {
      veredicto = 'revisar'
      motivo = `${m.inactivo(hace)}${deAgente}${m.conCambios(pendientes)}`
    } else if (l.commitsSueltos) {
      veredicto = 'revisar'
      motivo = `${m.inactivo(hace)}${deAgente}${m.commitsSueltos(l.commitsSueltos)}`
    } else {
      veredicto = 'cerrar'
      motivo = `${m.inactivo(hace)}${deAgente}${m.nadaQuePerder(l.rama, l.sinSubir)}`
    }
  }

  return {
    ruta: l.ruta,
    repo: l.repo,
    nombre: carpeta(l.ruta),
    rama: l.rama,
    head: l.head,
    origen,
    cambios: l.cambios,
    sinSeguir: l.sinSeguir,
    sinSubir: l.sinSubir,
    commitsSueltos: l.commitsSueltos,
    ultimaActividad: l.ultimaActividad,
    kb: l.kb,
    enUso: sesion ? { pid: sesion.pid, nombre: sesion.nombre } : null,
    bloqueo: l.bloqueo,
    falta: l.falta,
    veredicto,
    motivo,
    cerrable
  }
}

/** Los worktrees con su veredicto: primero los que se proponen cerrar, y entre iguales el más quieto. */
export function evaluarWorktrees(lecturas: readonly LecturaWorktree[], vivos: Vivos, config: ConfigWorktrees): Worktree[] {
  return lecturas
    .map((l) => evaluarWorktree(l, vivos, config))
    .sort(
      (a, b) =>
        ORDEN[a.veredicto] - ORDEN[b.veredicto] ||
        (a.ultimaActividad ?? 0) - (b.ultimaActividad ?? 0) ||
        a.ruta.localeCompare(b.ruta)
    )
}

/** La foto con los worktrees de la última búsqueda, evaluados contra las sesiones que trae. */
export function agregarWorktrees(
  foto: Foto,
  lecturas: readonly LecturaWorktree[] | null,
  revisados: number | null,
  diasInactivo: number
): Foto {
  if (foto.error || !lecturas) return foto
  const worktrees = evaluarWorktrees(lecturas, foto, { ahora: foto.tomadaEn, diasInactivo, home: foto.home })
  const cerrar = worktrees.filter((w) => w.veredicto === 'cerrar')
  return {
    ...foto,
    worktrees: worktrees.slice(0, MAX_WORKTREES_EN_FOTO),
    worktreesRevisados: revisados,
    totales: {
      ...foto.totales,
      worktrees: worktrees.length,
      worktreesCerrar: cerrar.length,
      worktreesCerrarKb: cerrar.reduce((n, w) => n + (w.kb ?? 0), 0)
    }
  }
}

/** Si el worktree tiene algo que se pierde al cerrarlo. */
export function tieneQuePerder(w: Pick<Worktree, 'cambios' | 'sinSeguir' | 'commitsSueltos'>): boolean {
  return w.cambios + w.sinSeguir + w.commitsSueltos > 0
}

export function objetivoDe(w: Worktree): ObjetivoWorktree {
  return { ruta: w.ruta, head: w.head, conCambios: tieneQuePerder(w) }
}

/**
 * Si se puede cerrar lo que pidió el panel, contra los worktrees leídos ahora mismo: tiene que
 * seguir ahí, en el mismo commit, sin que nadie lo use y sin cambios de los que la confirmación
 * no haya avisado. `forzar` es el `--force` que git pide para borrar archivos sin confirmar.
 */
export function validarCierre(
  o: ObjetivoWorktree,
  actuales: readonly Worktree[]
): { worktree: Worktree; forzar: boolean } | { rechazo: string; nombre: string } {
  const m = t().worktree
  const w = actuales.find((x) => x.ruta === o.ruta)
  if (!w) return { rechazo: m.yaNoEsta, nombre: carpeta(o.ruta) }
  if (!w.cerrable) return { rechazo: w.motivo, nombre: w.nombre }
  if (w.head !== o.head) return { rechazo: m.cambio, nombre: w.nombre }
  if (tieneQuePerder(w) && !o.conCambios) return { rechazo: m.tieneCambios, nombre: w.nombre }
  return { worktree: w, forzar: w.cambios + w.sinSeguir > 0 }
}

/** Las carpetas desde las que buscar repositorios: donde se abrió Claude Code y donde trabajan
 *  o trabajaron las sesiones que el plugin conoce. */
export function carpetasCandidatas(
  claudeJson: string | null,
  sesiones: readonly { cwd: string | null }[]
): string[] {
  const rutas = new Set<string>(claudeJson ? carpetasDeClaude(claudeJson) : [])
  for (const s of sesiones) if (s.cwd?.startsWith('/')) rutas.add(s.cwd)
  return [...rutas].map((r) => (r.length > 1 ? r.replace(/\/+$/, '') : r))
}
