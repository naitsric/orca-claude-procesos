// Tipos que comparten el worker y el panel. Solo datos JSON: viajan por plugin.request y posts.
import type { Idioma } from './i18n'

/** Qué es cada proceso dentro del árbol de una sesión de Claude Code. */
export type Rol =
  | 'sesion' // el propio `claude`
  | 'mcp' // servidor MCP que lanzó la sesión (y sus hijos)
  | 'bash' // shell de la herramienta Bash
  | 'comando' // algo que corrió dentro de ese shell
  | 'servidor' // escucha en un puerto TCP
  | 'tunel' // SSM, ssh -L, ngrok, cloudflared
  | 'navegador' // Chrome o Chromium de Playwright
  | 'despierto' // caffeinate
  | 'agente' // otro `claude` lanzado desde la sesión
  | 'otro'

/** cerrar: no cumple ninguna función. revisar: decide tú. dejar: lo necesita una sesión viva. */
export type Veredicto = 'cerrar' | 'revisar' | 'dejar'

/** segura: el plugin vio nacer el proceso bajo una sesión o lleva una marca de Claude.
 *  probable: solo se parece a algo que lanza Claude (por ejemplo un servidor MCP sin dueño). */
export type Certeza = 'segura' | 'probable'

export type Proceso = {
  pid: number
  ppid: number
  pgid: number
  /** Milisegundos desde epoch, aproximado a partir de `etime` (±1 s). Junto al pid identifica el proceso. */
  inicio: number
  rssKb: number
  cpu: number
  /** Etiqueta corta: el ejecutable o lo que lo describe mejor. */
  nombre: string
  /** Línea de comando recortada. */
  comando: string
  rol: Rol
  /** Profundidad bajo la sesión o el huérfano de arriba, para sangrar la lista. */
  nivel: number
  puertos: number[]
  veredicto: Veredicto
  motivo: string
  /** Colgaba de launchd (o de systemd en Linux) aunque su sesión sigue viva: sobrevivirá cuando la cierres. */
  desacoplado?: boolean
}

export type Sesion = {
  pid: number
  inicio: number
  /** El nombre que Claude Code le da a la sesión (`~/.claude/sessions/<pid>.json`). */
  nombre: string | null
  /** El id de la conversación: con él se retoma (`claude --resume <id>`). */
  sessionId: string | null
  /** `busy` mientras trabaja; `idle` esperando un mensaje. null si Claude Code no lo publica. */
  estado: string | null
  /** Desde cuándo está en ese estado. */
  estadoDesde: number | null
  rssKb: number
  /** La sesión más todos sus procesos. */
  rssTotalKb: number
  cpu: number
  tty: string
  cwd: string | null
  /** Dónde corre: Orca, Ghostty, Terminal, Claude Desktop u otra. */
  anfitrion: string
  /** El id de `--resume`, si arrancó así. */
  reanuda: string | null
  comando: string
  procesos: Proceso[]
  veredicto: Veredicto
  motivo: string
}

export type Huerfano = Proceso & {
  certeza: Certeza
  cwd: string | null
  /** La sesión que lo lanzó, si el plugin la conoció. */
  origen: { pid: number; nombre: string | null; cwd: string | null; termino: number | null } | null
}

export type Totales = {
  sesiones: number
  procesos: number
  rssKb: number
  huerfanos: number
  huerfanosSeguros: number
  huerfanosRssKb: number
  /** Puertos que ocupan los huérfanos. */
  puertosHuerfanos: number[]
  /** Worktrees enlazados que encontró la última búsqueda. */
  worktrees: number
  /** Los que el plugin propone cerrar (veredicto `cerrar`) y lo que ocupan en disco. */
  worktreesCerrar: number
  worktreesCerrarKb: number
}

// ---------------------------------------------------------------------------------------------
// Worktrees

/**
 * De dónde salió un worktree.
 * claude: de `claude --worktree` o de la herramienta EnterWorktree (vive en `.claude/worktrees/`).
 * agente: de un subagente aislado (Claude lo bloquea con «claude agent …»).
 * orca: un workspace de Orca. otro: cualquier otro `git worktree add`.
 */
export type OrigenWorktree = 'claude' | 'agente' | 'orca' | 'otro'

/** Un worktree enlazado (nunca la carpeta principal del repositorio). */
export type Worktree = {
  ruta: string
  /** La carpeta principal del repositorio al que pertenece. */
  repo: string
  /** El último segmento de la ruta. */
  nombre: string
  /** null con HEAD suelto. */
  rama: string | null
  /** El commit en el que está. Junto a la ruta identifica lo que viste al pedir que se cierre. */
  head: string
  origen: OrigenWorktree
  /** Archivos con cambios sin confirmar y archivos sin seguir: lo que se pierde al cerrarlo. */
  cambios: number
  sinSeguir: number
  /** Commits que la rama no ha subido. null si la rama no tiene upstream. */
  sinSubir: number | null
  /** Con HEAD suelto: commits a los que no llega ninguna rama ni etiqueta. Se pierden al cerrarlo. */
  commitsSueltos: number
  /** La última vez que algo se movió ahí: un commit, un archivo sin confirmar, una conversación. */
  ultimaActividad: number | null
  /** Lo que ocupa en disco. null hasta que se mide. */
  kb: number | null
  /** La sesión viva que trabaja en él. */
  enUso: { pid: number; nombre: string | null } | null
  /** El motivo del bloqueo de Git (`git worktree lock`), si lo tiene. */
  bloqueo: string | null
  /** Su carpeta ya no existe: solo queda el registro de Git. */
  falta: boolean
  veredicto: Veredicto
  motivo: string
  /** Si el plugin lo deja cerrar. No: lo usa una sesión, es de Orca, lo bloqueó otro o no se pudo leer. */
  cerrable: boolean
}

/** Un worktree a cerrar, como lo viste: `head` evita cerrar uno que cambió después, y
 *  `conCambios` dice si la confirmación ya avisó de que sus cambios sin confirmar se descartan. */
export type ObjetivoWorktree = { ruta: string; head: string; conCambios: boolean }

export type ResultadoWorktree = {
  ruta: string
  nombre: string
  resultado: 'cerrado' | 'rechazado' | 'error'
  detalle?: string
}

/** Una foto del sistema: lo que el worker devuelve y publica en cada revisión. */
export type Foto = {
  tomadaEn: number
  /** El idioma de los textos que trae (motivos, anfitriones, errores): los paneles pintan en ese. */
  idioma: Idioma
  /** El home del usuario, para mostrar rutas con ~. */
  home: string
  sesiones: Sesion[]
  huerfanos: Huerfano[]
  /** Los worktrees de Git de los repositorios donde trabajó Claude, según la última búsqueda. */
  worktrees: Worktree[]
  /** Cuándo terminó esa búsqueda. null: todavía no hay ninguna (corre aparte de las revisiones). */
  worktreesRevisados: number | null
  totales: Totales
  /** El worker no pudo leer los procesos; el resto viene vacío. */
  error?: string
}

/** Un proceso a cerrar. `inicio` evita matar un pid que el sistema ya reutilizó. */
export type Objetivo = { pid: number; inicio: number }

export type Senal = 'TERM' | 'KILL'

export type ResultadoCierre = {
  pid: number
  nombre: string
  resultado: 'cerrado' | 'sigue-vivo' | 'rechazado' | 'error'
  detalle?: string
}

// ---------------------------------------------------------------------------------------------
// Historial para las gráficas

/** Una sesión en una muestra. `clave` es `s<pid>`; `cpu` es % de un núcleo (puede pasar de 100). */
export type MuestraSesion = { clave: string; nombre: string; cpu: number; rssKb: number }

/** Lo que cuesta Claude en un instante: cada sesión con todo lo que lanzó, y los huérfanos. */
export type Muestra = {
  t: number
  sesiones: MuestraSesion[]
  huerfanosCpu: number
  huerfanosRssKb: number
}

/** Las muestras de la última media hora y el color fijo de cada sesión (índice de paleta; -1 es
 *  «Otras»). El color sigue a la sesión: no cambia aunque otras aparezcan o se cierren. */
export type Historial = {
  muestras: Muestra[]
  colores: Record<string, number>
  intervaloMs: number
}
