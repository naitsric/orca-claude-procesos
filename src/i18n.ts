// Los textos que ve el usuario, en cada idioma. El inglés es la base: el tipo `Textos` sale de él,
// así que otro idioma no compila si le falta un texto o le sobra uno. Puro y sin imports: lo usan
// el worker, los dos paneles y las pruebas.
//
// Cada contexto (el worker, cada panel) tiene su idioma actual. El worker lo elige con el ajuste
// `idioma` y el idioma de Orca que le cuentan los paneles, y lo manda en cada foto
// (`Foto.idioma`): los paneles pintan con ese, para que sus textos y los del worker (los motivos)
// no salgan mezclados.

export type Idioma = 'en' | 'es'

export const IDIOMAS: readonly Idioma[] = ['en', 'es']

/** El idioma del plugin para un locale BCP-47 de Orca: el que tenga con ese idioma, o inglés. */
export function idiomaDeLocale(locale: string | null | undefined): Idioma {
  const base = (locale ?? '').trim().toLowerCase().split(/[-_]/)[0]
  return IDIOMAS.find((i) => i === base) ?? 'en'
}

/** El ajuste `idioma`: `en` o `es` lo fijan; `auto` (o nada) sigue al idioma de Orca. */
export function resolverIdioma(ajuste: unknown, localeOrca: string | null | undefined): Idioma {
  return IDIOMAS.find((i) => i === ajuste) ?? idiomaDeLocale(localeOrca)
}

const pl = (n: number, uno: string, varios: string): string => `${n} ${n === 1 ? uno : varios}`

const en = {
  /** Separador decimal de memoria y CPU. */
  coma: '.',
  porcentaje: (n: string) => `${n}%`,
  nombrePlugin: 'Claude Processes',

  roles: {
    sesion: ['Claude session', 'Claude sessions'],
    mcp: ['MCP server', 'MCP servers'],
    bash: ['Bash command', 'Bash commands'],
    comando: ['command process', 'command processes'],
    servidor: ['server', 'servers'],
    tunel: ['tunnel', 'tunnels'],
    navegador: ['browser process', 'browser processes'],
    despierto: ['caffeinate', 'caffeinate'],
    agente: ['other Claude session', 'other Claude sessions'],
    otro: ['other process', 'other processes']
  } as Record<string, readonly [string, string]>,
  veredictos: { cerrar: 'Close', revisar: 'Review', dejar: 'Keep' },
  procesos: (n: number) => pl(n, 'process', 'processes'),
  sesiones: (n: number) => pl(n, 'session', 'sessions'),
  huerfanos: (n: number) => pl(n, 'orphan', 'orphans'),
  procesosHuerfanos: (n: number) => pl(n, 'orphaned process', 'orphaned processes'),
  worktrees: (n: number) => pl(n, 'worktree', 'worktrees'),
  worktreesInactivos: (n: number) => pl(n, 'inactive worktree', 'inactive worktrees'),
  /** Comillas alrededor del nombre de una sesión. */
  cita: (s: string) => `“${s}”`,

  /** Los motivos que calcula el worker (src/procesos.ts). */
  motivo: {
    shellBash: 'Bash shell',
    etiqueta: { bash: 'Command', comando: 'Command', servidor: 'Server', tunel: 'Tunnel' } as Record<string, string>,
    escucha: (puertos: string) => ` Listening on ${puertos}.`,
    desacoplado: 'Detached from the session: it will keep running after you close the session.',
    mcp: 'MCP server of this session; it closes with the session.',
    despierto: 'Keeps the Mac awake while Claude works.',
    agente: 'Another Claude instance started from this session.',
    navegador: 'Browser this session controls.',
    enSegundoPlano: (etiqueta: string, hace: string) => `${etiqueta} running in the background for ${hace}.`,
    corriendo: (etiqueta: string) => `${etiqueta} Claude is running.`,
    deLaSesion: 'Process of this session.',
    sinTerminal: 'No terminal',
    otraTerminal: 'Other terminal',
    retomar: (id: string) => ` Resume it with claude --resume ${id}.`,
    quedoSola: 'Session with no terminal and no parent process: it was left on its own.',
    desde: (hace: string) => ` for ${hace}`,
    trabajando: (desde: string) => `Working${desde}.`,
    inactivaLarga: (desde: string, mem: string, retomar: string) =>
      `Idle${desde}. If you no longer use it, close it to free ${mem}.${retomar}`,
    esperando: (desde: string) => `Waiting for your message${desde}.`,
    estado: (estado: string, desde: string) => `Status “${estado}”${desde}.`,
    abiertaLarga: (hace: string, mem: string, retomar: string) =>
      `Open for ${hace} and idle now. If you no longer use it, close it to free ${mem}.${retomar}`,
    trabajandoCpu: (cpu: number) => `Working (CPU ${cpu}%).`,
    abierta: 'Session open.',
    ocupa: (puertos: string) => ` Holds ${puertos}.`,
    mcpSinDueno:
      'Looks like an MCP server with no owner. It may belong to another app (Cursor, Claude Desktop…); check it before closing it.',
    hijoDeHuerfano: 'Child of an orphaned Claude process.',
    /** `donde` y `cuando` ya traen su espacio: « “mi-app”», « in mi-app», « 1 h ago». */
    sesionTermino: (donde: string, cuando: string) => `Its Claude session${donde} ended${cuando} and this process kept running.`,
    donde: (nombre: string) => ` “${nombre}”`,
    enCarpeta: (carpeta: string) => ` in ${carpeta}`,
    hace: (hace: string) => ` ${hace} ago`,
    shellSinSesion: 'Bash shell of a Claude session that no longer exists.'
  },

  /** Los motivos de los worktrees y por qué no se cierra uno (src/worktrees.ts, src/git.ts). */
  worktree: {
    origenes: { claude: 'Claude Code', agente: 'a Claude subagent', orca: 'Orca', otro: 'git worktree add' } as Record<string, string>,
    headSuelto: 'detached HEAD',
    bloqueado: (motivo: string) => `Locked in Git${motivo ? ` (“${motivo}”)` : ''}. Unlock it before closing it.`,
    falta: "Its folder no longer exists: only Git's record of it is left.",
    /** `sesion` ya viene entre comillas. */
    enUso: (sesion: string) => `The session ${sesion} is working in it.`,
    enUsoAgente: (sesion: string) => `A subagent of the session ${sesion} is working in it.`,
    conHuerfano: (nombre: string) => `An orphaned process (${nombre}) is still running in it. Close that process first.`,
    sinLeer: (error: string) => `Couldn't read its state: ${error}`,
    orca: 'Orca workspace.',
    orcaInactivo: (hace: string) => `Orca workspace with no activity for ${hace}. Close it from Orca's sidebar.`,
    sinFecha: "Couldn't tell when it was last used.",
    activo: (hace: string) => `Active ${hace} ago.`,
    inactivo: (hace: string) => `No activity for ${hace}.`,
    deAgente: ' A subagent left it behind.',
    conCambios: (n: number) =>
      ` It has ${pl(n, 'uncommitted change', 'uncommitted changes')}: closing it discards ${n === 1 ? 'it' : 'them'}.`,
    commitsSueltos: (n: number) =>
      ` ${n === 1 ? 'Its last commit is' : `Its last ${n} commits are`} on no branch: closing it loses ${n === 1 ? 'it' : 'them'}.`,
    nadaQuePerder: (rama: string | null, sinSubir: number | null) =>
      ` Nothing to lose: no uncommitted changes${
        rama ? `, and the branch ${rama} stays${sinSubir ? ` with its ${pl(sinSubir, 'unpushed commit', 'unpushed commits')}` : ''}` : ''
      }.`,
    yaNoEsta: 'It no longer shows up as a worktree.',
    cambio: 'It has new commits since you looked at it. Check it again.',
    tieneCambios: 'It has uncommitted changes now. Check it again.',
    gitFallo: (error: string) => `Git couldn't remove it: ${error}`,
    yaCerrando: 'Still closing the worktrees from before. Wait for it to finish.'
  },

  /** Lo que dice el sistema al cerrar (src/sistema.ts). */
  sistema: {
    noEncontre: (comando: string, procps: boolean) =>
      `Couldn't find ${comando}${procps ? ' (it comes in the procps package)' : ''}.`,
    yaNoEsDeClaude: 'It no longer shows up as a Claude process.',
    otroProceso: 'That pid now belongs to another process.',
    yaNoEsHuerfano: 'It is no longer an orphan: it belongs to a live Claude session now.',
    yaNoEsSeguro: 'It is no longer a certain orphan. Check it again.'
  },

  /** La barra de estado, la notificación y los comandos (src/worker.ts). */
  worker: {
    barraError: 'Claude: error',
    noPudeLeer: (error: string) => `Couldn't read the processes: ${error}`,
    ocupando: (puertos: string) => ` holding ${puertos}`,
    clic: 'Click: check now',
    sobrevivieron: (n: number, nombres: string) =>
      n === 1
        ? `1 Claude process kept running after its session closed: ${nombres}.`
        : `${n} Claude processes kept running after their session closed: ${nombres}.`,
    ocupan: (n: number, puertos: string) => ` ${n === 1 ? 'It holds' : 'They hold'} ${puertos}.`,
    resumen: (sesiones: number, procesos: number, mem: string) =>
      `${pl(sesiones, 'Claude session', 'Claude sessions')}, ${pl(procesos, 'process', 'processes')}, ${mem}.`,
    resumenHuerfanos: (n: number, seguros: number, mem: string, puertos: string) =>
      `${pl(n, 'orphan', 'orphans')} (${seguros} certain, ${mem})${puertos ? ` on ${puertos}` : ''}.`,
    sinHuerfanos: 'No orphans.',
    paraRevisar: (n: number) => `${pl(n, 'session', 'sessions')} to review.`,
    nadaQueCerrar: 'No certain orphans to close.',
    confirmaHuerfanosEnPanel: (n: number, nombres: string) =>
      `${pl(n, 'certain orphan', 'certain orphans')}: ${nombres}. Nothing was closed: confirm in the Orphans tab of the Claude Processes panel.`,
    worktreesParaCerrar: (n: number, disco: string) =>
      `${pl(n, 'inactive worktree', 'inactive worktrees')} to close${disco ? ` (${disco})` : ''}`,
    worktreesQuietos: (n: number, nombres: string) =>
      n === 1
        ? `1 worktree has gone unused and has nothing to lose: ${nombres}. Close it from the Worktrees tab.`
        : `${n} worktrees have gone unused and have nothing to lose: ${nombres}. Close them from the Worktrees tab.`,
    resumenWorktrees: (n: number, cerrar: number) =>
      `${pl(n, 'worktree', 'worktrees')}${cerrar ? `, ${cerrar} inactive with nothing to lose` : ''}.`,
    nadaWorktrees: 'No inactive worktrees to close.',
    confirmaEnPanel: (n: number, nombres: string) =>
      `${pl(n, 'inactive worktree', 'inactive worktrees')} with nothing to lose: ${nombres}. Nothing was closed: confirm in the Worktrees tab of the Claude Processes panel.`
  },

  /** Las confirmaciones y sus resultados (src/confirmar.ts). */
  confirmar: {
    trabajando: 'working',
    inactiva: (hace: string | null) => (hace ? `idle ${hace}` : 'idle'),
    abiertaHace: (hace: string) => `open ${hace}`,
    yMas: (n: number) => `and ${n} more`,
    cortaTarea: 'It is working now: the task in progress will be cut off.',
    inactivaDesde: (hace: string) => `It has been idle for ${hace}.`,
    noSePierde: (id: string) => `The conversation isn't lost: resume it with claude --resume ${id}`,
    incluyeDesprendidos: (n: number) =>
      `Includes ${pl(n, 'process', 'processes')} that had detached from the session.`,
    libera: (puertos: string) => `Frees ${puertos}.`,
    cerrarSesionPregunta: (nombre: string) => `Close the session “${nombre}”?`,
    seCierranConMemoria: (n: number, mem: string) => `Closing ${pl(n, 'process', 'processes')} (${mem}):`,
    laSesion: (mem: string) => `claude, the session · ${mem}`,
    cerrarSesion: 'Close session',
    mantenerla: 'Keep it open',
    cerreSesion: (nombre: string) => `Closed the session “${nombre}”`,
    conEllosHijos: (n: number) =>
      n === 1 ? '1 child process closes with them.' : `${n} child processes close with them.`,
    pierdeHerramientas: "The session loses those MCP servers' tools until you restart it.",
    esperaComando: 'Claude may be waiting for that command to finish; it will see it fail.',
    sigueAbierta: 'The session stays open.',
    cerrarDeSesion: (n: number, nombre: string) => `Close ${pl(n, 'process', 'processes')} of “${nombre}”?`,
    seCierran: (_n: number) => 'Closing:',
    cerrarN: (n: number) => `Close ${pl(n, 'process', 'processes')}`,
    cancelar: 'Cancel',
    cerreN: (n: number) => `Closed ${pl(n, 'process', 'processes')}`,
    yaTermino: 'Their Claude session already ended: nobody is using them.',
    otraApp: (nombres: string) => `${nombres} could belong to another app (Cursor, Claude Desktop…).`,
    cerrarHuerfanos: (n: number) => `Close ${pl(n, 'orphaned process', 'orphaned processes')}?`,
    origenDudoso: 'uncertain origin',
    sesionInexistente: 'from a session that no longer exists',
    deSesion: (nombre: string) => `from “${nombre}”`,
    forzarPregunta: (n: number) => `Force ${pl(n, 'process', 'processes')} to close?`,
    noRespondieron: "They didn't respond to a normal close:",
    sigkill: 'Forcing (SIGKILL) ends them on the spot, without letting them save anything.',
    forzar: 'Force close',
    dejarlos: 'Leave them',
    forzado: (n: number) => `Force-closed ${pl(n, 'process', 'processes')}`,
    /** Lo que el comando «cerrar huérfanos seguros» listó y ya no entra en la confirmación. */
    quedanFuera: (n: number, nombres: string) =>
      n === 1
        ? `Left out: ${nombres}. The command listed it, but it is gone or is no longer the same certain orphan.`
        : `Left out: ${nombres}. The command listed them, but they are gone or are no longer the same certain orphans.`,
    nadaCerrado: 'Nothing was closed',
    noSePudo: "Couldn't close",
    cerreDe: (cerrados: number, total: number) => `Closed ${cerrados} of ${pl(total, 'process', 'processes')}`,
    workerNoRespondio: (error: string) => `The worker didn't respond: ${error}`,
    cerrados: (n: number) => `${pl(n, 'process', 'processes')} closed.`,
    siguenVivos: (lista: string) => `Still running: ${lista}.`,
    cerrarWorktrees: (n: number) => `Close ${pl(n, 'worktree', 'worktrees')}?`,
    seCierranWorktrees: (disco: string) => (disco ? `Closing (frees ${disco}):` : 'Closing:'),
    sinActividad: (hace: string) => `no activity for ${hace}`,
    soloRegistro: 'folder already gone',
    ramasQuedan: (n: number): string =>
      n === 1 ? 'Its branch and commits stay in the repository.' : 'Their branches and commits stay in the repository.',
    carpetaSeBorra: (n: number) =>
      `${n === 1 ? 'The folder is' : 'The folders are'} deleted with everything inside, ignored files included (node_modules, .env).`,
    descartaCambios: (n: number, nombres: string) =>
      `${nombres} ${n === 1 ? 'has' : 'have'} uncommitted changes: they are discarded for good.`,
    pierdeCommits: (nombres: string) => `${nombres}: the commits that are on no branch are lost.`,
    conActividad: (n: number, nombres: string) => `${nombres} had activity recently: make sure ${n === 1 ? 'it is' : 'they are'} done.`,
    cerrarWorktreesN: (n: number) => `Close ${pl(n, 'worktree', 'worktrees')}`,
    cerreWorktrees: (n: number) => `Closed ${pl(n, 'worktree', 'worktrees')}`,
    cerreWorktreesDe: (cerrados: number, total: number) => `Closed ${cerrados} of ${pl(total, 'worktree', 'worktrees')}`,
    sigueCerrando: (faltan: number) => `Still closing ${pl(faltan, 'worktree', 'worktrees')}`,
    tardaEnBorrar: 'Git is still deleting the folders. The list shrinks as it goes.'
  },

  /** El panel «Claude Processes» (src/panel.tsx). */
  panel: {
    revisarAhora: 'Check now',
    revisado: 'checked',
    workerNoRespondio: "The worker didn't respond",
    noPudeLeer: "Couldn't read the processes",
    revisando: 'Checking processes',
    vista: 'View',
    pestanaSesiones: (n: number) => `Sessions (${n})`,
    pestanaHuerfanos: (n: number) => `Orphans (${n})`,
    columnas: { proceso: 'Process', estado: 'Status', mem: 'Memory', edad: 'Time' },
    revisarDudoso: 'Review (?)',
    forzar: 'Force close',
    listo: 'Done',
    cerrando: 'Closing',
    cerrandoPuntos: 'Closing…',
    carpeta: 'Folder',
    yMas: (n: number) => `and ${n} more…`,
    terminal: 'Terminal',
    abierta: 'Opened',
    hace: (hace: string) => `${hace} ago`,
    procesosDeSesion: (pid: number) => `Processes of session ${pid}`,
    todosBien: 'All its processes are fine.',
    sinHijos: 'It has no child processes.',
    cerrarSeleccionados: (n: number) => (n ? `Close ${n} selected` : 'Close selected'),
    marcarSobran: 'Select unneeded',
    cerrarSesion: 'Close session',
    soloRevisar: 'Only what needs review',
    nadaQueRevisar: 'Nothing to review',
    sinSesiones: 'No Claude sessions',
    todoEnUso: 'All sessions and their processes are in use.',
    ningunClaude: 'No claude process is running.',
    sinHuerfanos: 'No orphans',
    ningunoSobrevivio: 'No Claude process outlived its session.',
    explicaDudoso:
      '“Review (?)” is a loose MCP server that may belong to another app. The rest started under a Claude session that has ended.',
    huerfanosTabla: 'Orphaned processes',
    marcarSeguros: 'Select certain ones',
    siguieronVivos: (mem: string, puertos: string) =>
      `They kept running after their Claude session closed. They hold ${mem}${puertos ? ` and ${puertos}` : ''}.`,
    cerrarlo: 'Close it',
    cerrarTodos: 'Close all',
    ver: 'View',
    pestanaWorktrees: (n: number) => `Worktrees (${n})`,
    columnasWorktrees: { worktree: 'Worktree', estado: 'Status', disco: 'Size', quieto: 'Idle' },
    buscandoWorktrees: 'Looking for worktrees',
    sinWorktrees: 'No worktrees',
    ningunWorktree: 'No repository Claude Code worked in has a worktree open.',
    explicaWorktrees:
      'Worktrees of the repositories Claude Code worked in. “Close” marks the ones with no recent activity and nothing to lose. Closing one deletes its folder; its branch stays.',
    worktreesTabla: 'Git worktrees',
    marcarInactivos: 'Select inactive',
    rama: 'Branch',
    creadoPor: 'Created by',
    cambiosSinConfirmar: (n: number) => pl(n, 'uncommitted change', 'uncommitted changes'),
    commitsSinSubir: (n: number) => pl(n, 'unpushed commit', 'unpushed commits'),
    worktreesSobran: (disco: string) =>
      `Nobody has used them in a while and there is nothing to lose: no uncommitted changes, and their branches stay.${
        disco ? ` They take ${disco}.` : ''
      }`,
    cerrarWorktrees: (n: number): string => (n === 1 ? 'Close worktree' : 'Close worktrees')
  },

  /** El panel «Claude Activity» (src/graficas.ts) y sus series (src/series.ts). */
  actividad: {
    titulo: 'Claude Activity',
    rango: 'Time range',
    leyenda: 'Legend',
    sesiones: 'Sessions',
    memoria: 'Memory',
    dondeMemoria: 'Where the memory is',
    enVivo: (s: number) => `Live · every ${s} s`,
    sinMuestras: 'No recent samples',
    cpuClaude: 'Claude CPU',
    pico: (v: string) => `peak ${v}`,
    picoEn: (v: string, min: number) => `peak ${v} in ${min} min`,
    trabajandoEsperando: (trabajando: number, esperando: number) => `${trabajando} working · ${esperando} waiting`,
    ningunaAbierta: 'none open',
    huerfanos: 'Orphans',
    sinDueno: (mem: string) => `${mem} unowned`,
    ninguno: 'none',
    juntando: 'Collecting data: the graph appears with the second sample.',
    ariaGrafica: (cpu: boolean, min: number) =>
      `Claude ${cpu ? 'CPU' : 'memory'} over the last ${min} minutes. Use the arrow keys to move through it.`,
    ahora: 'now',
    haceHora: (hace: string, hora: string) => `${hace} ago · ${hora}`,
    total: 'Total',
    esperandoRevision: 'Waiting for the first check.',
    grupos: {
      claude: 'Claude (the sessions)',
      mcp: 'MCP servers',
      comandos: 'Commands, servers and tunnels',
      navegadores: 'Browsers',
      otros: 'Other',
      huerfanos: '⚠ Orphans'
    },
    sinSesiones: 'No Claude sessions open.',
    pie: 'Expand a session to close only some of its processes without closing it. The Claude Processes panel has the details of each one.',
    cerrarLaSesion: (nombre: string) => `Close the session ${nombre}`,
    sinProcesos: 'no processes · ',
    verProcesos: (abierta: boolean, n: number) => `${abierta ? '▾ Hide' : '▸ Show'} its processes (${n})`,
    sobran: (n: number) => `· ${n} unneeded`,
    etiquetaVeredicto: { cerrar: 'unneeded', revisar: 'review' } as Record<string, string>,
    procesosDe: (nombre: string) => `Processes of ${nombre}`,
    marcarSobran: (n: number) => `Select unneeded (${n})`,
    ayuda: 'The session stays open; only the selected processes close (with their children).',
    verTabla: 'Show as table',
    columnas: { sesion: 'Session', cpu: 'CPU', pico: 'Peak', memoria: 'Memory' },
    huerfanosSerie: 'Orphans',
    otrasSesiones: (n: number) => `${n} other sessions`
  }
}

export type Textos = typeof en

const es: Textos = {
  coma: ',',
  porcentaje: (n) => `${n} %`,
  nombrePlugin: 'Procesos de Claude',

  roles: {
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
  },
  veredictos: { cerrar: 'Cerrar', revisar: 'Revisar', dejar: 'Dejar' },
  procesos: (n) => pl(n, 'proceso', 'procesos'),
  sesiones: (n) => pl(n, 'sesión', 'sesiones'),
  huerfanos: (n) => pl(n, 'huérfano', 'huérfanos'),
  procesosHuerfanos: (n) => pl(n, 'proceso huérfano', 'procesos huérfanos'),
  worktrees: (n) => pl(n, 'worktree', 'worktrees'),
  worktreesInactivos: (n) => pl(n, 'worktree inactivo', 'worktrees inactivos'),
  cita: (s) => `«${s}»`,

  motivo: {
    shellBash: 'shell de Bash',
    etiqueta: { bash: 'Comando', comando: 'Comando', servidor: 'Servidor', tunel: 'Túnel' },
    escucha: (puertos) => ` Escucha en ${puertos}.`,
    desacoplado: 'Se desprendió de la sesión: seguirá vivo cuando la cierres.',
    mcp: 'Servidor MCP de esta sesión; se cierra con ella.',
    despierto: 'Evita que el Mac se duerma mientras Claude trabaja.',
    agente: 'Otra instancia de Claude lanzada desde esta sesión.',
    navegador: 'Navegador que controla esta sesión.',
    enSegundoPlano: (etiqueta, hace) => `${etiqueta} en segundo plano desde hace ${hace}.`,
    corriendo: (etiqueta) => `${etiqueta} que Claude está corriendo.`,
    deLaSesion: 'Proceso de esta sesión.',
    sinTerminal: 'Sin terminal',
    otraTerminal: 'Otra terminal',
    retomar: (id) => ` Se retoma con claude --resume ${id}.`,
    quedoSola: 'Sesión sin terminal ni proceso padre: quedó sola.',
    desde: (hace) => ` desde hace ${hace}`,
    trabajando: (desde) => `Trabajando${desde}.`,
    inactivaLarga: (desde, mem, retomar) => `Inactiva${desde}. Si ya no la usas, ciérrala para liberar ${mem}.${retomar}`,
    esperando: (desde) => `Esperando tu mensaje${desde}.`,
    estado: (estado, desde) => `Estado «${estado}»${desde}.`,
    abiertaLarga: (hace, mem, retomar) =>
      `Abierta hace ${hace} y sin actividad ahora. Si ya no la usas, ciérrala para liberar ${mem}.${retomar}`,
    trabajandoCpu: (cpu) => `Trabajando (CPU ${cpu} %).`,
    abierta: 'Sesión abierta.',
    ocupa: (puertos) => ` Ocupa ${puertos}.`,
    mcpSinDueno:
      'Parece un servidor MCP sin dueño. Puede ser de otra app (Cursor, Claude Desktop…); revísalo antes de cerrarlo.',
    hijoDeHuerfano: 'Hijo de un proceso huérfano de Claude.',
    sesionTermino: (donde, cuando) => `Su sesión de Claude${donde} terminó${cuando} y este proceso siguió vivo.`,
    donde: (nombre) => ` «${nombre}»`,
    enCarpeta: (carpeta) => ` en ${carpeta}`,
    hace: (hace) => ` hace ${hace}`,
    shellSinSesion: 'Shell de Bash de una sesión de Claude que ya no existe.'
  },

  worktree: {
    origenes: { claude: 'Claude Code', agente: 'un subagente de Claude', orca: 'Orca', otro: 'git worktree add' },
    headSuelto: 'HEAD suelto',
    bloqueado: (motivo) => `Bloqueado en Git${motivo ? ` («${motivo}»)` : ''}. Desbloquéalo antes de cerrarlo.`,
    falta: 'Su carpeta ya no existe: solo queda el registro de Git.',
    enUso: (sesion) => `La sesión ${sesion} trabaja en él.`,
    enUsoAgente: (sesion) => `Un subagente de la sesión ${sesion} trabaja en él.`,
    conHuerfano: (nombre) => `Un proceso huérfano (${nombre}) sigue corriendo en él. Cierra primero ese proceso.`,
    sinLeer: (error) => `No pude leer su estado: ${error}`,
    orca: 'Workspace de Orca.',
    orcaInactivo: (hace) => `Workspace de Orca sin actividad desde hace ${hace}. Ciérralo desde la barra lateral de Orca.`,
    sinFecha: 'No pude saber cuándo se usó por última vez.',
    activo: (hace) => `Con actividad hace ${hace}.`,
    inactivo: (hace) => `Sin actividad desde hace ${hace}.`,
    deAgente: ' Lo dejó un subagente.',
    conCambios: (n) =>
      ` Tiene ${pl(n, 'cambio sin confirmar', 'cambios sin confirmar')}: al cerrarlo se ${n === 1 ? 'descarta' : 'descartan'}.`,
    commitsSueltos: (n) =>
      ` ${n === 1 ? 'Su último commit no está' : `Sus últimos ${n} commits no están`} en ninguna rama: al cerrarlo se ${
        n === 1 ? 'pierde' : 'pierden'
      }.`,
    nadaQuePerder: (rama, sinSubir) =>
      ` No hay nada que perder: no tiene cambios sin confirmar${
        rama ? ` y la rama ${rama} se queda${sinSubir ? ` con ${pl(sinSubir, 'commit sin subir', 'commits sin subir')}` : ''}` : ''
      }.`,
    yaNoEsta: 'Ya no aparece como worktree.',
    cambio: 'Tiene commits nuevos desde que lo viste. Revísalo otra vez.',
    tieneCambios: 'Ahora tiene cambios sin confirmar. Revísalo otra vez.',
    gitFallo: (error) => `Git no pudo quitarlo: ${error}`,
    yaCerrando: 'Todavía estoy cerrando los worktrees de antes. Espera a que termine.'
  },

  sistema: {
    noEncontre: (comando, procps) => `No encontré ${comando}${procps ? ' (viene en el paquete procps)' : ''}.`,
    yaNoEsDeClaude: 'Ya no aparece como proceso de Claude.',
    otroProceso: 'Ese pid ya es de otro proceso.',
    yaNoEsHuerfano: 'Ya no es un huérfano: ahora es de una sesión de Claude viva.',
    yaNoEsSeguro: 'Ya no es un huérfano seguro. Revísalo de nuevo.'
  },

  worker: {
    barraError: 'Claude: error',
    noPudeLeer: (error) => `No pude leer los procesos: ${error}`,
    ocupando: (puertos) => ` ocupando ${puertos}`,
    clic: 'Clic: revisar ahora',
    sobrevivieron: (n, nombres) =>
      `${pl(n, 'proceso de Claude siguió vivo', 'procesos de Claude siguieron vivos')} tras cerrar su sesión: ${nombres}.`,
    ocupan: (n, puertos) => ` ${n === 1 ? 'Ocupa' : 'Ocupan'} ${puertos}.`,
    resumen: (sesiones, procesos, mem) =>
      `${pl(sesiones, 'sesión', 'sesiones')} de Claude, ${pl(procesos, 'proceso', 'procesos')}, ${mem}.`,
    resumenHuerfanos: (n, seguros, mem, puertos) =>
      `${pl(n, 'huérfano', 'huérfanos')} (${seguros} seguros, ${mem})${puertos ? ` en ${puertos}` : ''}.`,
    sinHuerfanos: 'Sin huérfanos.',
    paraRevisar: (n) => `${pl(n, 'sesión para revisar', 'sesiones para revisar')}.`,
    nadaQueCerrar: 'No hay huérfanos seguros que cerrar.',
    confirmaHuerfanosEnPanel: (n, nombres) =>
      `${pl(n, 'huérfano seguro', 'huérfanos seguros')}: ${nombres}. No cerré nada: confirma en la pestaña Huérfanos del panel «Procesos de Claude».`,
    worktreesParaCerrar: (n, disco) =>
      `${pl(n, 'worktree inactivo', 'worktrees inactivos')} para cerrar${disco ? ` (${disco})` : ''}`,
    worktreesQuietos: (n, nombres) =>
      n === 1
        ? `1 worktree quedó sin uso y no tiene nada que perder: ${nombres}. Ciérralo desde la pestaña Worktrees.`
        : `${n} worktrees quedaron sin uso y no tienen nada que perder: ${nombres}. Ciérralos desde la pestaña Worktrees.`,
    resumenWorktrees: (n, cerrar) =>
      `${pl(n, 'worktree', 'worktrees')}${cerrar ? `, ${pl(cerrar, 'inactivo', 'inactivos')} sin nada que perder` : ''}.`,
    nadaWorktrees: 'No hay worktrees inactivos que cerrar.',
    confirmaEnPanel: (n, nombres) =>
      `${pl(n, 'worktree inactivo', 'worktrees inactivos')} sin nada que perder: ${nombres}. No cerré nada: confirma en la pestaña Worktrees del panel «Procesos de Claude».`
  },

  confirmar: {
    trabajando: 'trabajando',
    inactiva: (hace) => (hace ? `inactiva ${hace}` : 'inactiva'),
    abiertaHace: (hace) => `abierta ${hace}`,
    yMas: (n) => `y ${n} más`,
    cortaTarea: 'Está trabajando ahora: la tarea en curso se corta.',
    inactivaDesde: (hace) => `Está inactiva desde hace ${hace}.`,
    noSePierde: (id) => `La conversación no se pierde: la retomas con claude --resume ${id}`,
    incluyeDesprendidos: (n) =>
      `Incluye ${pl(n, 'proceso que se había desprendido', 'procesos que se habían desprendido')} de la sesión.`,
    libera: (puertos) => `Libera ${puertos}.`,
    cerrarSesionPregunta: (nombre) => `¿Cerrar la sesión «${nombre}»?`,
    seCierranConMemoria: (n, mem) => `Se ${n === 1 ? 'cierra' : 'cierran'} ${pl(n, 'proceso', 'procesos')} (${mem}):`,
    laSesion: (mem) => `claude, la sesión · ${mem}`,
    cerrarSesion: 'Cerrar sesión',
    mantenerla: 'Mantenerla abierta',
    cerreSesion: (nombre) => `Cerré la sesión «${nombre}»`,
    conEllosHijos: (n) => `Con ellos se ${n === 1 ? 'cierra' : 'cierran'} ${pl(n, 'proceso hijo', 'procesos hijos')}.`,
    pierdeHerramientas: 'La sesión pierde las herramientas de esos servidores MCP hasta que la reinicies.',
    esperaComando: 'Claude puede estar esperando a que ese comando termine; lo verá fallar.',
    sigueAbierta: 'La sesión sigue abierta.',
    cerrarDeSesion: (n, nombre) => `¿Cerrar ${pl(n, 'proceso', 'procesos')} de «${nombre}»?`,
    seCierran: (n) => `Se ${n === 1 ? 'cierra' : 'cierran'}:`,
    cerrarN: (n) => `Cerrar ${pl(n, 'proceso', 'procesos')}`,
    cancelar: 'Cancelar',
    cerreN: (n) => `Cerré ${pl(n, 'proceso', 'procesos')}`,
    yaTermino: 'Su sesión de Claude ya terminó: nadie los está usando.',
    otraApp: (nombres) => `${nombres} podría ser de otra app (Cursor, Claude Desktop…).`,
    cerrarHuerfanos: (n) => `¿Cerrar ${pl(n, 'proceso huérfano', 'procesos huérfanos')}?`,
    origenDudoso: 'origen dudoso',
    sesionInexistente: 'de una sesión que ya no existe',
    deSesion: (nombre) => `de «${nombre}»`,
    forzarPregunta: (n) => `¿Forzar el cierre de ${pl(n, 'proceso', 'procesos')}?`,
    noRespondieron: 'No respondieron al cierre normal:',
    sigkill: 'Forzar (SIGKILL) los termina en el acto, sin dejarles guardar nada.',
    forzar: 'Forzar cierre',
    dejarlos: 'Dejarlos así',
    forzado: (n) => `Forcé el cierre de ${pl(n, 'proceso', 'procesos')}`,
    quedanFuera: (n, nombres) =>
      n === 1
        ? `Queda fuera: ${nombres}. El comando lo listó, pero ya no está o ya no es el mismo huérfano seguro.`
        : `Quedan fuera: ${nombres}. El comando los listó, pero ya no están o ya no son los mismos huérfanos seguros.`,
    nadaCerrado: 'No se cerró nada',
    noSePudo: 'No se pudo cerrar',
    cerreDe: (cerrados, total) => `Cerré ${cerrados} de ${pl(total, 'proceso', 'procesos')}`,
    workerNoRespondio: (error) => `El worker no respondió: ${error}`,
    cerrados: (n) => `${pl(n, 'proceso cerrado', 'procesos cerrados')}.`,
    siguenVivos: (lista) => `Siguen vivos: ${lista}.`,
    cerrarWorktrees: (n) => `¿Cerrar ${pl(n, 'worktree', 'worktrees')}?`,
    seCierranWorktrees: (disco) => (disco ? `Se cierran (libera ${disco}):` : 'Se cierran:'),
    sinActividad: (hace) => `sin actividad hace ${hace}`,
    soloRegistro: 'su carpeta ya no existe',
    ramasQuedan: (n) =>
      n === 1 ? 'Su rama y sus commits se quedan en el repositorio.' : 'Sus ramas y sus commits se quedan en el repositorio.',
    carpetaSeBorra: (n) =>
      `${n === 1 ? 'La carpeta se borra' : 'Las carpetas se borran'} con todo lo que hay dentro, también los archivos ignorados (node_modules, .env).`,
    descartaCambios: (n, nombres) =>
      `${nombres} ${n === 1 ? 'tiene' : 'tienen'} cambios sin confirmar: se descartan para siempre.`,
    pierdeCommits: (nombres) => `${nombres}: los commits que no están en ninguna rama se pierden.`,
    conActividad: (n, nombres) =>
      `${nombres} ${n === 1 ? 'tuvo' : 'tuvieron'} actividad hace poco: confirma que ya ${n === 1 ? 'terminó' : 'terminaron'}.`,
    cerrarWorktreesN: (n) => `Cerrar ${pl(n, 'worktree', 'worktrees')}`,
    cerreWorktrees: (n) => `Cerré ${pl(n, 'worktree', 'worktrees')}`,
    cerreWorktreesDe: (cerrados, total) => `Cerré ${cerrados} de ${pl(total, 'worktree', 'worktrees')}`,
    sigueCerrando: (faltan) => `Sigo cerrando ${pl(faltan, 'worktree', 'worktrees')}`,
    tardaEnBorrar: 'Git todavía está borrando las carpetas. La lista se acorta a medida que avanza.'
  },

  panel: {
    revisarAhora: 'Revisar ahora',
    revisado: 'revisado',
    workerNoRespondio: 'El worker no respondió',
    noPudeLeer: 'No pude leer los procesos',
    revisando: 'Revisando procesos',
    vista: 'Vista',
    pestanaSesiones: (n) => `Sesiones (${n})`,
    pestanaHuerfanos: (n) => `Huérfanos (${n})`,
    columnas: { proceso: 'Proceso', estado: 'Estado', mem: 'Memoria', edad: 'Tiempo' },
    revisarDudoso: 'Revisar (?)',
    forzar: 'Forzar cierre',
    listo: 'Listo',
    cerrando: 'Cerrando',
    cerrandoPuntos: 'Cerrando…',
    carpeta: 'Carpeta',
    yMas: (n) => `y ${n} más…`,
    terminal: 'Terminal',
    abierta: 'Abierta',
    hace: (hace) => `hace ${hace}`,
    procesosDeSesion: (pid) => `Procesos de la sesión ${pid}`,
    todosBien: 'Todos sus procesos están bien.',
    sinHijos: 'No tiene procesos hijos.',
    cerrarSeleccionados: (n) => (n ? `Cerrar ${pl(n, 'seleccionado', 'seleccionados')}` : 'Cerrar seleccionados'),
    marcarSobran: 'Marcar los que sobran',
    cerrarSesion: 'Cerrar sesión',
    soloRevisar: 'Solo lo que hay que revisar',
    nadaQueRevisar: 'Nada que revisar',
    sinSesiones: 'No hay sesiones de Claude',
    todoEnUso: 'Todas las sesiones y sus procesos están en uso.',
    ningunClaude: 'Ningún proceso claude está corriendo.',
    sinHuerfanos: 'Sin huérfanos',
    ningunoSobrevivio: 'Ningún proceso de Claude sobrevivió a su sesión.',
    explicaDudoso:
      '«Revisar (?)» es un servidor MCP suelto que puede ser de otra app. Los demás nacieron bajo una sesión de Claude que ya terminó.',
    huerfanosTabla: 'Procesos huérfanos',
    marcarSeguros: 'Marcar los seguros',
    siguieronVivos: (mem, puertos) =>
      `Siguieron vivos después de cerrar su sesión de Claude. Ocupan ${mem}${puertos ? ` y ${puertos}` : ''}.`,
    cerrarlo: 'Cerrarlo',
    cerrarTodos: 'Cerrar todos',
    ver: 'Ver',
    pestanaWorktrees: (n) => `Worktrees (${n})`,
    columnasWorktrees: { worktree: 'Worktree', estado: 'Estado', disco: 'Tamaño', quieto: 'Quieto' },
    buscandoWorktrees: 'Buscando worktrees',
    sinWorktrees: 'Sin worktrees',
    ningunWorktree: 'Ningún repositorio donde trabajó Claude Code tiene un worktree abierto.',
    explicaWorktrees:
      'Los worktrees de los repositorios donde trabajó Claude Code. «Cerrar» marca los que no tienen actividad reciente ni nada que perder. Cerrar uno borra su carpeta; su rama se queda.',
    worktreesTabla: 'Worktrees de Git',
    marcarInactivos: 'Marcar los inactivos',
    rama: 'Rama',
    creadoPor: 'Lo creó',
    cambiosSinConfirmar: (n) => pl(n, 'cambio sin confirmar', 'cambios sin confirmar'),
    commitsSinSubir: (n) => pl(n, 'commit sin subir', 'commits sin subir'),
    worktreesSobran: (disco) =>
      `Nadie los usa hace tiempo y no hay nada que perder: no tienen cambios sin confirmar y sus ramas se quedan.${
        disco ? ` Ocupan ${disco}.` : ''
      }`,
    cerrarWorktrees: (n) => (n === 1 ? 'Cerrar worktree' : 'Cerrar worktrees')
  },

  actividad: {
    titulo: 'Actividad de Claude',
    rango: 'Rango de tiempo',
    leyenda: 'Leyenda',
    sesiones: 'Sesiones',
    memoria: 'Memoria',
    dondeMemoria: 'Dónde está la memoria',
    enVivo: (s) => `En vivo · cada ${s} s`,
    sinMuestras: 'Sin muestras recientes',
    cpuClaude: 'CPU de Claude',
    pico: (v) => `pico ${v}`,
    picoEn: (v, min) => `pico ${v} en ${min} min`,
    trabajandoEsperando: (trabajando, esperando) => `${trabajando} trabajando · ${esperando} esperando`,
    ningunaAbierta: 'ninguna abierta',
    huerfanos: 'Huérfanos',
    sinDueno: (mem) => `${mem} sin dueño`,
    ninguno: 'ninguno',
    juntando: 'Juntando datos: la gráfica aparece con la segunda muestra.',
    ariaGrafica: (cpu, min) => `${cpu ? 'CPU' : 'Memoria'} de Claude en los últimos ${min} minutos. Flechas para recorrer.`,
    ahora: 'ahora',
    haceHora: (hace, hora) => `hace ${hace} · ${hora}`,
    total: 'Total',
    esperandoRevision: 'Esperando la primera revisión.',
    grupos: {
      claude: 'Claude (las sesiones)',
      mcp: 'Servidores MCP',
      comandos: 'Comandos, servidores y túneles',
      navegadores: 'Navegadores',
      otros: 'Otros',
      huerfanos: '⚠ Huérfanos'
    },
    sinSesiones: 'No hay sesiones de Claude abiertas.',
    pie: 'Despliega una sesión para cerrar solo algunos de sus procesos sin cerrarla. El detalle de cada uno está en el panel «Procesos de Claude».',
    cerrarLaSesion: (nombre) => `Cerrar la sesión ${nombre}`,
    sinProcesos: 'sin procesos · ',
    verProcesos: (abierta, n) => `${abierta ? '▾ Ocultar' : '▸ Ver'} sus procesos (${n})`,
    sobran: (n) => `· ${n} ${n === 1 ? 'sobra' : 'sobran'}`,
    etiquetaVeredicto: { cerrar: 'sobra', revisar: 'revisar' },
    procesosDe: (nombre) => `Procesos de ${nombre}`,
    marcarSobran: (n) => `Marcar los que sobran (${n})`,
    ayuda: 'La sesión sigue abierta; solo se cierran los marcados (y sus hijos).',
    verTabla: 'Ver como tabla',
    columnas: { sesion: 'Sesión', cpu: 'CPU', pico: 'Pico', memoria: 'Memoria' },
    huerfanosSerie: 'Huérfanos',
    otrasSesiones: (n) => `Otras ${n} sesiones`
  }
}

const TEXTOS: Record<Idioma, Textos> = { en, es }

let actual: Idioma = 'en'

/** Cambia el idioma de este contexto (el worker o un panel). Uno que no existe es inglés. */
export function usarIdioma(idioma: Idioma | undefined): void {
  actual = IDIOMAS.find((i) => i === idioma) ?? 'en'
}

export function idioma(): Idioma {
  return actual
}

/** Los textos del idioma actual. */
export function t(): Textos {
  return TEXTOS[actual]
}
