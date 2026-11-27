// El worker del plugin. Mientras el plugin está activo Orca lo mantiene vivo (tiene un item en la
// barra de estado), así que revisa cada N segundos, recuerda qué procesos nacieron bajo cada
// sesión (eso es lo que delata a los huérfanos) y le avisa al panel y a la barra.
//
// El idioma: Orca no le dice al worker en cuál está, pero sí a los paneles. Cada panel lo manda al
// pedir una foto; el worker lo guarda (para la barra y las notificaciones de la próxima vez) y,
// con el ajuste `idioma`, decide en cuál salen la foto, la barra y los avisos.
//
// Los worktrees se buscan aparte (src/git.ts): correr git en cada repositorio tarda más que ps,
// así que va cada varios minutos y sin frenar las revisiones. Cada foto lleva los de la última
// búsqueda, evaluados contra las sesiones vivas de ese momento.
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { nombreWorktree, worktreesParaCerrar } from './confirmar'
import { carpeta, memoria as fmtMem, puertos as fmtPuertos } from './formato'
import { cerrarWorktrees, detenerLecturas, leerWorktrees, medirWorktrees } from './git'
import {
  agregarMuestra,
  historialVacio,
  INTERVALO_MUESTRA_MS,
  leerHistorial,
  tomarMuestra,
  type CpuPrevia
} from './historial'
import { idioma, resolverIdioma, t, usarIdioma, type Idioma } from './i18n'
import { leerMemoria, mismoProceso, type Memoria } from './procesos'
import { cerrar, leerFilas, tomarFoto, uid, type Opciones } from './sistema'
import type { Foto, Historial, Objetivo, ObjetivoWorktree, ResultadoCierre, ResultadoWorktree, Senal } from './tipos'
import { agregarWorktrees, evaluarWorktrees, objetivoDe, type LecturaWorktree } from './worktrees'

const CLAVE_MEMORIA = 'memoria'
const CLAVE_HISTORIAL = 'historial'
/** El idioma de Orca (BCP-47) que contó el último panel. */
const CLAVE_LOCALE = 'localeOrca'
/** Las rutas de los worktrees inactivos de los que ya se avisó: sobreviven al reinicio de Orca,
 *  porque un worktree olvidado dura semanas y no hay que repetirlo cada vez. */
const CLAVE_WORKTREES_AVISADOS = 'worktreesAvisados'
/** Cada cuánto se vuelven a buscar los worktrees por cuenta propia: es un `git status` en cada
 *  uno, y con cien worktrees eso son varios segundos de CPU. */
const INTERVALO_WORKTREES_MS = 10 * 60_000
/** Lo que un pedido de cierre espera antes de responder «sigo en eso»: el panel no puede
 *  esperar más de 120 s, y borrar cien carpetas con node_modules tarda más. */
const ESPERA_CIERRE_MS = 90_000
/** Mientras se cierran worktrees, cada cuánto se publica una foto con los que quedan. */
const AVANCE_CADA_MS = 3000
/** Cuando lo pide un panel (al abrirse o con «Revisar ahora»), una búsqueda de hace poco vale. */
const WORKTREES_FRESCOS_MS = 20_000
/** El historial se guarda cada minuto, no en cada muestra. */
const GUARDAR_CADA = Math.round(60_000 / INTERVALO_MUESTRA_MS)

type Ajustes = Opciones & {
  intervaloSegundos: number
  avisarHuerfanos: boolean
  diasWorktreeInactivo: number
  avisarWorktrees: boolean
  idioma: Idioma
}

let memoria: Memoria | null = null
let memoriaGuardada = ''
let enCurso: Promise<unknown> = Promise.resolve()
let temporizador: ReturnType<typeof setTimeout> | null = null
let detenido = false
/** Huérfanos de los que ya se avisó, para no repetir la notificación en cada revisión. */
let avisados: Objetivo[] = []

// Gráficas: el historial de la última media hora y lo necesario para la próxima muestra.
let historial: Historial | null = null
let cpuPrevia: CpuPrevia = new Map()
/** El nombre de cada sesión según la última revisión completa (las muestras no leen archivos). */
let nombres = new Map<number, string>()
let temporizadorMuestra: ReturnType<typeof setTimeout> | null = null
let sinGuardar = 0
/** null hasta leerlo de storage; '' si ningún panel lo ha contado todavía (entonces, inglés). */
let localeOrca: string | null = null
let leyendoLocale: Promise<void> | null = null

// Worktrees: lo que leyó la última búsqueda y cuándo terminó.
let lecturas: LecturaWorktree[] | null = null
let lecturasEn: number | null = null
/** Cuándo empezó la última búsqueda, haya salido bien o no. */
let ultimaBusqueda = 0
let buscando: Promise<void> | null = null
/** Sube con cada cierre de worktrees: una búsqueda que empezó antes ya no vale. */
let cierresDeWorktrees = 0
/** Un cierre de worktrees que sigue borrando: no se empieza otro ni se busca mientras tanto. */
let cerrandoWorktrees = false
let midiendo = false
/** Cambia cada vez que el worker arranca o se apaga: lo que quedó corriendo de antes se descarta. */
let vida = 0
/** Las sesiones de la última foto: sus carpetas dicen en qué repositorios buscar. */
let sesionesVistas: { cwd: string | null }[] = []
let worktreesAvisados: Set<string> | null = null

function numero(valor: unknown, porDefecto: number, min: number, max: number): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? Math.min(max, Math.max(min, valor)) : porDefecto
}

/** Una sola lectura de storage, compartida: la primera revisión y el pedido de un panel llegan a
 *  la vez al arrancar, y una lectura tardía no debe pisar el idioma que el panel acaba de contar. */
async function cargarLocale(orca: OrcaWorkerApi): Promise<string> {
  leyendoLocale ??= orca.storage.get(CLAVE_LOCALE).then(
    (guardado) => {
      localeOrca ??= typeof guardado === 'string' ? guardado : ''
    },
    () => {
      localeOrca ??= ''
    }
  )
  await leyendoLocale
  return localeOrca ?? ''
}

/** Lo que un panel dice del idioma de Orca. Se guarda solo si cambió. */
async function anotarLocale(orca: OrcaWorkerApi, locale: unknown): Promise<void> {
  if (typeof locale !== 'string' || !locale || locale === (await cargarLocale(orca))) return
  localeOrca = locale
  await orca.storage.set(CLAVE_LOCALE, locale).catch((e: unknown) => orca.log(`storage.set: ${String(e)}`))
}

/** Lee los ajustes y deja puesto el idioma que piden. */
async function ajustes(orca: OrcaWorkerApi): Promise<Ajustes> {
  const s = await orca.settings.get().catch(() => ({}) as Record<string, JsonValue>)
  const op = {
    intervaloSegundos: numero(s.intervaloSegundos, 15, 5, 300),
    horasSesionLarga: numero(s.horasSesionLarga, 12, 1, 720),
    avisarHuerfanos: s.avisarHuerfanos !== false,
    diasWorktreeInactivo: numero(s.diasWorktreeInactivo, 7, 1, 365),
    avisarWorktrees: s.avisarWorktrees !== false,
    idioma: resolverIdioma(s.idioma, await cargarLocale(orca))
  }
  usarIdioma(op.idioma)
  return op
}

async function cargarMemoria(orca: OrcaWorkerApi): Promise<Memoria> {
  if (!memoria) {
    const guardada = await orca.storage.get(CLAVE_MEMORIA).catch(() => null)
    memoria = leerMemoria(guardada)
    memoriaGuardada = JSON.stringify(memoria)
  }
  return memoria
}

/** Una revisión o un cierre a la vez: los dos leen y escriben la memoria. */
function enSerie<T>(tarea: () => Promise<T>): Promise<T> {
  const resultado = enCurso.then(tarea, tarea)
  enCurso = resultado.catch(() => undefined)
  return resultado
}

function fotoConError(error: unknown): Foto {
  return {
    tomadaEn: Date.now(),
    idioma: idioma(),
    home: '',
    sesiones: [],
    huerfanos: [],
    worktrees: [],
    worktreesRevisados: null,
    totales: {
      sesiones: 0,
      procesos: 0,
      rssKb: 0,
      huerfanos: 0,
      huerfanosSeguros: 0,
      huerfanosRssKb: 0,
      puertosHuerfanos: [],
      worktrees: 0,
      worktreesCerrar: 0,
      worktreesCerrarKb: 0
    },
    error: error instanceof Error ? error.message : String(error)
  }
}

async function publicar(orca: OrcaWorkerApi, foto: Foto, nueva: Memoria | null, op: Ajustes): Promise<void> {
  if (nueva) {
    memoria = nueva
    const texto = JSON.stringify(nueva)
    if (texto !== memoriaGuardada) {
      await orca.storage.set(CLAVE_MEMORIA, nueva as unknown as JsonValue)
      memoriaGuardada = texto
    }
  }
  if (!foto.error) {
    nombres = new Map(foto.sesiones.map((s) => [s.pid, s.nombre ?? carpeta(s.cwd, foto.home)]))
    sesionesVistas = foto.sesiones.map((s) => ({ cwd: s.cwd }))
  }
  orca.panels.post('procesos.foto', foto)
  await actualizarBarra(orca, foto)
  if (op.avisarHuerfanos) await avisar(orca, foto)
  if (op.avisarWorktrees) await avisarWorktrees(orca, foto)
}

/** La foto con los worktrees de la última búsqueda. */
function conWorktrees(foto: Foto, op: Ajustes): Foto {
  return agregarWorktrees(foto, lecturas, lecturasEn, op.diasWorktreeInactivo)
}

async function actualizarBarra(orca: OrcaWorkerApi, foto: Foto): Promise<void> {
  const tot = foto.totales
  const tx = t()
  let text = `Claude ${tot.sesiones}`
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral'
  let tooltip = `${tx.sesiones(tot.sesiones)} · ${tx.procesos(tot.procesos)} · ${fmtMem(tot.rssKb)}`
  if (foto.error) {
    text = tx.worker.barraError
    tone = 'danger'
    tooltip = tx.worker.noPudeLeer(foto.error)
  } else if (tot.huerfanos) {
    text += ` · ${tx.huerfanos(tot.huerfanos)}`
    tone = tot.huerfanosSeguros && tot.puertosHuerfanos.length ? 'danger' : 'warning'
    tooltip += `\n${tx.huerfanos(tot.huerfanos)} (${fmtMem(tot.huerfanosRssKb)})`
    if (tot.puertosHuerfanos.length) tooltip += tx.worker.ocupando(fmtPuertos(tot.puertosHuerfanos))
  }
  // Los worktrees inactivos se cuentan, pero no cambian el color: no gastan memoria ni puertos.
  if (!foto.error && tot.worktreesCerrar) {
    text += ` · ${tx.worktrees(tot.worktreesCerrar)}`
    tooltip += `\n${tx.worker.worktreesParaCerrar(tot.worktreesCerrar, tot.worktreesCerrarKb ? fmtMem(tot.worktreesCerrarKb) : '')}`
  }
  tooltip += `\n${tx.worker.clic}`
  await orca.host.call('statusBar.update', { id: 'resumen', text, tone, tooltip }).catch((e: unknown) => {
    orca.log(`statusBar.update: ${String(e)}`)
  })
}

async function avisar(orca: OrcaWorkerApi, foto: Foto): Promise<void> {
  const seguros = foto.huerfanos.filter((h) => h.certeza === 'segura' && h.nivel === 0)
  const yaAvisado = (h: Objetivo) => avisados.some((a) => a.pid === h.pid && mismoProceso(a.inicio, h.inicio))
  const nuevos = seguros.filter((h) => !yaAvisado(h))
  avisados = seguros.map((h) => ({ pid: h.pid, inicio: h.inicio }))
  if (!nuevos.length) return
  const nombres = nuevos.slice(0, 3).map((h) => h.nombre).join(', ') + (nuevos.length > 3 ? '…' : '')
  const puertos = [...new Set(nuevos.flatMap((h) => h.puertos))]
  const tx = t()
  const body = tx.worker.sobrevivieron(nuevos.length, nombres) + (puertos.length ? tx.worker.ocupan(nuevos.length, fmtPuertos(puertos)) : '')
  await orca.host.call('notifications.show', { title: tx.nombrePlugin, body }).catch((e: unknown) => {
    orca.log(`notifications.show: ${String(e)}`)
  })
}

/** Avisa una vez de cada worktree que pasa a «cerrar»: inactivo y sin nada que perder. */
async function avisarWorktrees(orca: OrcaWorkerApi, foto: Foto): Promise<void> {
  if (foto.error || foto.worktreesRevisados === null) return
  if (!worktreesAvisados) {
    const guardado = await orca.storage.get(CLAVE_WORKTREES_AVISADOS).catch(() => null)
    worktreesAvisados = new Set(Array.isArray(guardado) ? guardado.filter((r): r is string => typeof r === 'string') : [])
  }
  const sobran = worktreesParaCerrar(foto)
  const nuevos = sobran.filter((w) => !worktreesAvisados!.has(w.ruta))
  const siguen = new Set(sobran.map((w) => w.ruta))
  if (!nuevos.length && siguen.size === worktreesAvisados.size) return
  worktreesAvisados = siguen
  await orca.storage.set(CLAVE_WORKTREES_AVISADOS, [...siguen]).catch((e: unknown) => orca.log(`storage.set: ${String(e)}`))
  if (!nuevos.length) return
  const lista = nuevos.slice(0, 3).map(nombreWorktree).join(', ') + (nuevos.length > 3 ? '…' : '')
  const tx = t()
  await orca.host
    .call('notifications.show', { title: tx.nombrePlugin, body: tx.worker.worktreesQuietos(nuevos.length, lista) })
    .catch((e: unknown) => orca.log(`notifications.show: ${String(e)}`))
}

/** Dónde buscar repositorios, además de `~/.claude.json`: las carpetas de las sesiones vivas y
 *  de las que el plugin recuerda. */
function carpetasConocidas(): { cwd: string | null }[] {
  return [...sesionesVistas, ...Object.values(memoria?.sesiones ?? {})]
}

/** Busca los worktrees y publica una foto con ellos. Después los mide (lo más lento) y, si algún
 *  tamaño cambió, publica otra. Una búsqueda a la vez: quien llega durante una espera a esa. */
function buscarWorktrees(orca: OrcaWorkerApi): Promise<void> {
  if (buscando) return buscando
  const mia = vida
  const sigo = (): boolean => mia === vida
  const busqueda = (async () => {
    ultimaBusqueda = Date.now()
    const cierres = cierresDeWorktrees
    const leidas = await leerWorktrees(carpetasConocidas(), sigo)
    if (!sigo() || cierres !== cierresDeWorktrees) return
    lecturas = leidas
    lecturasEn = Date.now()
    await revisar(orca, Infinity)
    if (midiendo || !sigo()) return
    midiendo = true
    void medirWorktrees(leidas, sigo)
      .then((cambio) => (cambio && sigo() ? revisar(orca, Infinity) : undefined))
      .catch((e: unknown) => orca.log(`medirWorktrees: ${String(e)}`))
      .finally(() => {
        if (sigo()) midiendo = false
      })
  })()
    .catch((e: unknown) => orca.log(`buscarWorktrees: ${String(e)}`))
    .finally(() => {
      if (buscando === busqueda) buscando = null
    })
  buscando = busqueda
  return busqueda
}

/** Revisa los procesos y publica la foto. Si la última búsqueda de worktrees tiene más de
 *  `vigenciaWorktrees`, lanza otra sin esperarla: su foto llega cuando termine. */
function revisar(orca: OrcaWorkerApi, vigenciaWorktrees = INTERVALO_WORKTREES_MS): Promise<Foto> {
  return enSerie(async () => {
    const op = await ajustes(orca)
    try {
      const tomada = await tomarFoto(await cargarMemoria(orca), op)
      const foto = conWorktrees(tomada.foto, op)
      await publicar(orca, foto, tomada.memoria, op)
      if (!detenido && !cerrandoWorktrees && Date.now() - ultimaBusqueda > vigenciaWorktrees) void buscarWorktrees(orca)
      return foto
    } catch (error) {
      orca.log(`revisar: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      const foto = fotoConError(error)
      await publicar(orca, foto, null, op)
      return foto
    }
  })
}

function cerrarProcesos(
  orca: OrcaWorkerApi,
  objetivos: Objetivo[],
  senal: Senal,
  arbol: boolean
): Promise<{ resultados: ResultadoCierre[]; foto: Foto }> {
  return enSerie(async () => {
    const op = await ajustes(orca)
    const cierre = await cerrar(objetivos, senal, arbol, await cargarMemoria(orca), op)
    const { resultados } = cierre
    orca.log(`cerrar (${senal}): ${resultados.map((r) => `${r.pid} ${r.resultado}`).join(', ')}`)
    const foto = conWorktrees(cierre.foto, op)
    await publicar(orca, foto, cierre.memoria, op)
    return { resultados, foto }
  })
}

/**
 * Quita worktrees. Como con los procesos, primero mira otra vez: toma una foto y lee los
 * worktrees ahora mismo, y solo quita los que sigan como el panel los mostró.
 *
 * Borrar va fuera de la serie de revisiones, que siguen corriendo y publican los que van
 * quedando. Si a los 90 s no terminó, responde con lo que lleva y sigue: el resultado completo
 * sale por `procesos.worktreesCerrados`.
 */
async function cerrarWorktreesPedidos(
  orca: OrcaWorkerApi,
  objetivos: ObjetivoWorktree[]
): Promise<{ resultados: ResultadoWorktree[]; foto: Foto; faltan: number }> {
  if (cerrandoWorktrees) throw Object.assign(new Error(t().worktree.yaCerrando), { code: 'conflict' })
  cerrandoWorktrees = true
  const mia = vida
  const hechos: ResultadoWorktree[] = []
  let ultimoAvance = Date.now()
  const trabajo = (async () => {
    const actuales = await enSerie(async () => {
      const op = await ajustes(orca)
      const tomada = await tomarFoto(await cargarMemoria(orca), op)
      const leidas = await leerWorktrees([...tomada.foto.sesiones, ...Object.values(tomada.memoria.sesiones)])
      // Esta lectura es la más nueva: una búsqueda que venga en camino ya no vale.
      cierresDeWorktrees++
      ultimaBusqueda = Date.now()
      lecturas = leidas
      lecturasEn = Date.now()
      return evaluarWorktrees(leidas, tomada.foto, {
        ahora: tomada.foto.tomadaEn,
        diasInactivo: op.diasWorktreeInactivo,
        home: tomada.foto.home
      })
    })
    const resultados = await cerrarWorktrees(objetivos, actuales, (r) => {
      hechos.push(r)
      if (r.resultado !== 'cerrado' || mia !== vida) return
      lecturas = (lecturas ?? []).filter((l) => l.ruta !== r.ruta)
      if (Date.now() - ultimoAvance < AVANCE_CADA_MS) return
      ultimoAvance = Date.now()
      void revisar(orca, Infinity)
    })
    orca.log(`cerrar worktrees: ${resultados.map((r) => `${r.ruta} ${r.resultado}${r.detalle ? ` (${r.detalle})` : ''}`).join(', ')}`)
    return resultados
  })().finally(() => {
    cierresDeWorktrees++
    ultimaBusqueda = Date.now()
    cerrandoWorktrees = false
  })

  let reloj: ReturnType<typeof setTimeout> | undefined
  const espera = new Promise<null>((resolve) => {
    reloj = setTimeout(() => resolve(null), ESPERA_CIERRE_MS)
  })
  try {
    const resultados = await Promise.race([trabajo, espera])
    if (resultados) return { resultados, foto: await revisar(orca, Infinity), faltan: 0 }
  } finally {
    clearTimeout(reloj)
  }
  const total = new Set(objetivos.map((o) => o.ruta)).size
  void trabajo
    .then(async (resultados) => {
      if (mia !== vida) return
      await revisar(orca, Infinity)
      orca.panels.post('procesos.worktreesCerrados', { resultados })
    })
    .catch((e: unknown) => orca.log(`cerrar worktrees: ${String(e)}`))
  return { resultados: [...hechos], foto: await revisar(orca, Infinity), faltan: Math.max(0, total - hechos.length) }
}

function resumen(foto: Foto): string {
  const w = t().worker
  if (foto.error) return w.noPudeLeer(foto.error)
  const tot = foto.totales
  const partes = [w.resumen(tot.sesiones, tot.procesos, fmtMem(tot.rssKb))]
  if (tot.huerfanos) {
    partes.push(w.resumenHuerfanos(tot.huerfanos, tot.huerfanosSeguros, fmtMem(tot.huerfanosRssKb), fmtPuertos(tot.puertosHuerfanos)))
  } else {
    partes.push(w.sinHuerfanos)
  }
  const revisar = foto.sesiones.filter((s) => s.veredicto !== 'dejar').length
  if (revisar) partes.push(w.paraRevisar(revisar))
  if (tot.worktrees) partes.push(w.resumenWorktrees(tot.worktrees, tot.worktreesCerrar))
  return partes.join(' ')
}

async function cargarHistorial(orca: OrcaWorkerApi): Promise<Historial> {
  if (!historial) historial = leerHistorial(await orca.storage.get(CLAVE_HISTORIAL).catch(() => null), Date.now())
  return historial
}

/** Una muestra liviana para las gráficas: solo ps, sin lsof ni archivos. */
async function muestrear(orca: OrcaWorkerApi): Promise<void> {
  const ahora = Date.now()
  const filas = await leerFilas(ahora)
  const { muestra, previa } = tomarMuestra(filas, await cargarMemoria(orca), uid(), cpuPrevia, nombres, ahora)
  // La CPU real necesita dos lecturas: la primera tras arrancar solo sirve de referencia (el
  // promedio de ps arrastra el último minuto y dibujaría un pico que no es de ahora).
  const primera = cpuPrevia.size === 0
  cpuPrevia = previa
  if (primera) return
  historial = agregarMuestra(await cargarHistorial(orca), muestra)
  orca.panels.post('procesos.muestra', { muestra, colores: historial.colores })
  if (++sinGuardar >= GUARDAR_CADA) {
    sinGuardar = 0
    await orca.storage.set(CLAVE_HISTORIAL, historial as unknown as JsonValue)
  }
}

function cicloMuestras(orca: OrcaWorkerApi): void {
  if (detenido) return
  temporizadorMuestra = setTimeout(() => {
    muestrear(orca)
      .catch((e: unknown) => orca.log(`muestrear: ${String(e)}`))
      .finally(() => cicloMuestras(orca))
  }, INTERVALO_MUESTRA_MS)
}

function programar(orca: OrcaWorkerApi, segundos: number): void {
  if (temporizador) clearTimeout(temporizador)
  if (detenido) return
  temporizador = setTimeout(() => {
    void ciclo(orca)
  }, segundos * 1000)
}

async function ciclo(orca: OrcaWorkerApi): Promise<void> {
  await revisar(orca)
  programar(orca, (await ajustes(orca)).intervaloSegundos)
}

export default function activate(orca: OrcaWorkerApi): void {
  detenido = false
  localeOrca = null
  leyendoLocale = null
  vida++
  lecturas = null
  lecturasEn = null
  ultimaBusqueda = 0
  buscando = null
  midiendo = false
  cerrandoWorktrees = false
  worktreesAvisados = null
  orca.panels.handle('procesos.foto', async (pedido) => {
    await anotarLocale(orca, pedido?.locale)
    return revisar(orca, WORKTREES_FRESCOS_MS)
  })
  orca.panels.handle('procesos.cerrar', ({ objetivos, senal, arbol }) => cerrarProcesos(orca, objetivos, senal, arbol))
  orca.panels.handle('procesos.cerrarWorktrees', ({ objetivos }) => cerrarWorktreesPedidos(orca, objetivos))
  orca.panels.handle('procesos.historial', async () => (await cargarHistorial(orca)) ?? historialVacio())

  orca.commands.register('revisar', async () => resumen(await revisar(orca)))
  orca.commands.register('cerrar-huerfanos', async () => {
    const foto = await revisar(orca)
    const objetivos = foto.huerfanos
      .filter((h) => h.certeza === 'segura' && h.nivel === 0)
      .map((h) => ({ pid: h.pid, inicio: h.inicio }))
    if (!objetivos.length) return t().worker.nadaQueCerrar
    const { resultados } = await cerrarProcesos(orca, objetivos, 'TERM', true)
    const cerrados = resultados.filter((r) => r.resultado === 'cerrado').length
    const vivos = resultados.filter((r) => r.resultado === 'sigue-vivo').map((r) => r.nombre)
    return t().worker.cerre(cerrados) + (vivos.length ? t().worker.siguenVivos(vivos.join(', ')) : '')
  })

  orca.commands.register('cerrar-worktrees', async () => {
    // Con una búsqueda recién hecha: el comando no tiene una lista a la vista que confirmar.
    await buscarWorktrees(orca)
    const foto = await revisar(orca, Infinity)
    const objetivos = worktreesParaCerrar(foto).map(objetivoDe)
    if (!objetivos.length) return t().worker.nadaWorktrees
    const { resultados, faltan } = await cerrarWorktreesPedidos(orca, objetivos)
    const cerrados = resultados.filter((r) => r.resultado === 'cerrado').length
    const fallidos = resultados.filter((r) => r.resultado !== 'cerrado').map((r) => `${r.nombre} (${r.detalle ?? r.resultado})`)
    return (
      t().worker.cerreWorktrees(cerrados) +
      (fallidos.length ? t().worker.noCerrados(fallidos.join(', ')) : '') +
      (faltan ? ` ${t().confirmar.sigueCerrando(faltan)}.` : '')
    )
  })

  // Revisa enseguida: si cambió el idioma, los paneles y la barra lo toman de la nueva foto.
  orca.settings.onDidChange(() => {
    void ciclo(orca)
  })

  void ciclo(orca)
  void muestrear(orca)
    .catch((e: unknown) => orca.log(`muestrear: ${String(e)}`))
    .finally(() => cicloMuestras(orca))
}

export function deactivate(): void {
  detenido = true
  vida++
  detenerLecturas()
  if (temporizador) clearTimeout(temporizador)
  if (temporizadorMuestra) clearTimeout(temporizadorMuestra)
  temporizador = null
  temporizadorMuestra = null
}
