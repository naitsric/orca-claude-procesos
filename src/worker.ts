// El worker del plugin. Mientras el plugin está activo Orca lo mantiene vivo (tiene un item en la
// barra de estado), así que revisa cada N segundos, recuerda qué procesos nacieron bajo cada
// sesión (eso es lo que delata a los huérfanos) y le avisa al panel y a la barra.
//
// El idioma: Orca no le dice al worker en cuál está, pero sí a los paneles. Cada panel lo manda al
// pedir una foto; el worker lo guarda (para la barra y las notificaciones de la próxima vez) y,
// con el ajuste `idioma`, decide en cuál salen la foto, la barra y los avisos.
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { carpeta, memoria as fmtMem, puertos as fmtPuertos } from './formato'
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
import type { Foto, Historial, Objetivo, ResultadoCierre, Senal } from './tipos'

const CLAVE_MEMORIA = 'memoria'
const CLAVE_HISTORIAL = 'historial'
/** El idioma de Orca (BCP-47) que contó el último panel. */
const CLAVE_LOCALE = 'localeOrca'
/** El historial se guarda cada minuto, no en cada muestra. */
const GUARDAR_CADA = Math.round(60_000 / INTERVALO_MUESTRA_MS)

type Ajustes = Opciones & { intervaloSegundos: number; avisarHuerfanos: boolean; idioma: Idioma }

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
    totales: { sesiones: 0, procesos: 0, rssKb: 0, huerfanos: 0, huerfanosSeguros: 0, huerfanosRssKb: 0, puertosHuerfanos: [] },
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
  if (!foto.error) nombres = new Map(foto.sesiones.map((s) => [s.pid, s.nombre ?? carpeta(s.cwd, foto.home)]))
  orca.panels.post('procesos.foto', foto)
  await actualizarBarra(orca, foto)
  if (op.avisarHuerfanos) await avisar(orca, foto)
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

function revisar(orca: OrcaWorkerApi): Promise<Foto> {
  return enSerie(async () => {
    const op = await ajustes(orca)
    try {
      const { foto, memoria: nueva } = await tomarFoto(await cargarMemoria(orca), op)
      await publicar(orca, foto, nueva, op)
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
    const { resultados, foto, memoria: nueva } = await cerrar(objetivos, senal, arbol, await cargarMemoria(orca), op)
    orca.log(`cerrar (${senal}): ${resultados.map((r) => `${r.pid} ${r.resultado}`).join(', ')}`)
    await publicar(orca, foto, nueva, op)
    return { resultados, foto }
  })
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
  orca.panels.handle('procesos.foto', async (pedido) => {
    await anotarLocale(orca, pedido?.locale)
    return revisar(orca)
  })
  orca.panels.handle('procesos.cerrar', ({ objetivos, senal, arbol }) => cerrarProcesos(orca, objetivos, senal, arbol))
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
  if (temporizador) clearTimeout(temporizador)
  if (temporizadorMuestra) clearTimeout(temporizadorMuestra)
  temporizador = null
  temporizadorMuestra = null
}
