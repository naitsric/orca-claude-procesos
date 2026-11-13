// El worker del plugin. Mientras el plugin está activo Orca lo mantiene vivo (tiene un item en la
// barra de estado), así que revisa cada N segundos, recuerda qué procesos nacieron bajo cada
// sesión (eso es lo que delata a los huérfanos) y le avisa al panel y a la barra.
import type { JsonValue } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { memoria as fmtMem, plural, puertos as fmtPuertos } from './formato'
import { leerMemoria, mismoProceso, type Memoria } from './procesos'
import { cerrar, tomarFoto, type Opciones } from './sistema'
import type { Foto, Objetivo, ResultadoCierre, Senal } from './tipos'

const CLAVE_MEMORIA = 'memoria'

type Ajustes = Opciones & { intervaloSegundos: number; avisarHuerfanos: boolean }

let memoria: Memoria | null = null
let memoriaGuardada = ''
let enCurso: Promise<unknown> = Promise.resolve()
let temporizador: ReturnType<typeof setTimeout> | null = null
let detenido = false
/** Huérfanos de los que ya se avisó, para no repetir la notificación en cada revisión. */
let avisados: Objetivo[] = []

function numero(valor: unknown, porDefecto: number, min: number, max: number): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? Math.min(max, Math.max(min, valor)) : porDefecto
}

async function ajustes(orca: OrcaWorkerApi): Promise<Ajustes> {
  const s = await orca.settings.get().catch(() => ({}) as Record<string, JsonValue>)
  return {
    intervaloSegundos: numero(s.intervaloSegundos, 15, 5, 300),
    horasSesionLarga: numero(s.horasSesionLarga, 12, 1, 720),
    avisarHuerfanos: s.avisarHuerfanos !== false
  }
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
  orca.panels.post('procesos.foto', foto)
  await actualizarBarra(orca, foto)
  if (op.avisarHuerfanos) await avisar(orca, foto)
}

async function actualizarBarra(orca: OrcaWorkerApi, foto: Foto): Promise<void> {
  const t = foto.totales
  let text = `Claude ${t.sesiones}`
  let tone: 'neutral' | 'warning' | 'danger' = 'neutral'
  let tooltip = `${plural(t.sesiones, 'sesión', 'sesiones')} · ${plural(t.procesos, 'proceso', 'procesos')} · ${fmtMem(t.rssKb)}`
  if (foto.error) {
    text = 'Claude: error'
    tone = 'danger'
    tooltip = `No pude leer los procesos: ${foto.error}`
  } else if (t.huerfanos) {
    text += ` · ${plural(t.huerfanos, 'huérfano', 'huérfanos')}`
    tone = t.huerfanosSeguros && t.puertosHuerfanos.length ? 'danger' : 'warning'
    tooltip += `\n${plural(t.huerfanos, 'huérfano', 'huérfanos')} (${fmtMem(t.huerfanosRssKb)})`
    if (t.puertosHuerfanos.length) tooltip += ` ocupando ${fmtPuertos(t.puertosHuerfanos)}`
  }
  tooltip += '\nClic: revisar ahora'
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
  const body =
    `${plural(nuevos.length, 'proceso de Claude siguió vivo', 'procesos de Claude siguieron vivos')} tras cerrar su sesión: ${nombres}.` +
    (puertos.length ? ` Ocupan ${fmtPuertos(puertos)}.` : '')
  await orca.host.call('notifications.show', { title: 'Procesos de Claude', body }).catch((e: unknown) => {
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
  if (foto.error) return `No pude leer los procesos: ${foto.error}`
  const t = foto.totales
  const partes = [
    `${plural(t.sesiones, 'sesión', 'sesiones')} de Claude, ${plural(t.procesos, 'proceso', 'procesos')}, ${fmtMem(t.rssKb)}.`
  ]
  if (t.huerfanos) {
    partes.push(
      `${plural(t.huerfanos, 'huérfano', 'huérfanos')} (${t.huerfanosSeguros} seguros, ${fmtMem(t.huerfanosRssKb)})` +
        (t.puertosHuerfanos.length ? ` en ${fmtPuertos(t.puertosHuerfanos)}.` : '.')
    )
  } else {
    partes.push('Sin huérfanos.')
  }
  const revisar = foto.sesiones.filter((s) => s.veredicto !== 'dejar').length
  if (revisar) partes.push(`${plural(revisar, 'sesión para revisar', 'sesiones para revisar')}.`)
  return partes.join(' ')
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
  orca.panels.handle('procesos.foto', () => revisar(orca))
  orca.panels.handle('procesos.cerrar', ({ objetivos, senal, arbol }) => cerrarProcesos(orca, objetivos, senal, arbol))

  orca.commands.register('revisar', async () => resumen(await revisar(orca)))
  orca.commands.register('cerrar-huerfanos', async () => {
    const foto = await revisar(orca)
    const objetivos = foto.huerfanos
      .filter((h) => h.certeza === 'segura' && h.nivel === 0)
      .map((h) => ({ pid: h.pid, inicio: h.inicio }))
    if (!objetivos.length) return 'No hay huérfanos seguros que cerrar.'
    const { resultados } = await cerrarProcesos(orca, objetivos, 'TERM', true)
    const cerrados = resultados.filter((r) => r.resultado === 'cerrado').length
    const vivos = resultados.filter((r) => r.resultado === 'sigue-vivo').map((r) => r.nombre)
    return `Cerré ${plural(cerrados, 'proceso', 'procesos')}.` + (vivos.length ? ` Siguen vivos: ${vivos.join(', ')}.` : '')
  })

  orca.settings.onDidChange(() => {
    void ajustes(orca).then((op) => programar(orca, op.intervaloSegundos))
  })

  void ciclo(orca)
}

export function deactivate(): void {
  detenido = true
  if (temporizador) clearTimeout(temporizador)
  temporizador = null
}
