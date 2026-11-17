// Lógica pura del historial que alimenta las gráficas: una muestra liviana (solo ps) cada pocos
// segundos, la CPU real entre muestras y un color fijo por sesión.
import { agrupar, mismoProceso, type Fila, type Memoria } from './procesos'
import type { Historial, Muestra, MuestraSesion } from './tipos'

export const INTERVALO_MUESTRA_MS = 5000
/** Lo que guardan las gráficas: media hora. */
export const VENTANA_MS = 30 * 60_000
/** Colores de sesión en la paleta; la sexta sesión en adelante va a «Otras». */
export const COLORES_SESION = 5

/** La última lectura de CPU acumulada de cada proceso, para calcular el uso entre muestras. */
export type CpuPrevia = Map<number, { inicio: number; cpuSeg: number; t: number }>

export function historialVacio(): Historial {
  return { muestras: [], colores: {}, intervaloMs: INTERVALO_MUESTRA_MS }
}

export function leerHistorial(valor: unknown, ahora: number): Historial {
  const h = valor as Partial<Historial> | null
  if (!h || !Array.isArray(h.muestras) || typeof h.colores !== 'object' || h.colores === null) return historialVacio()
  return {
    muestras: h.muestras.filter((m) => m && typeof m.t === 'number' && ahora - m.t <= VENTANA_MS && Array.isArray(m.sesiones)),
    colores: { ...h.colores },
    intervaloMs: INTERVALO_MUESTRA_MS
  }
}

/** % de un núcleo que usó el proceso desde la lectura anterior. Sin lectura anterior del mismo
 *  proceso, el promedio de ps. */
function cpuReal(f: Fila, previa: CpuPrevia, ahora: number): number {
  const p = previa.get(f.pid)
  if (p && mismoProceso(p.inicio, f.inicio) && ahora > p.t) {
    return Math.max(0, ((f.cpuSeg - p.cpuSeg) / ((ahora - p.t) / 1000)) * 100)
  }
  return f.cpu
}

const redondear = (n: number): number => Math.round(n * 10) / 10

export function tomarMuestra(
  filas: Fila[],
  memoria: Memoria,
  uid: number,
  previa: CpuPrevia,
  nombres: Map<number, string>,
  ahora: number
): { muestra: Muestra; previa: CpuPrevia } {
  const a = agrupar(filas, memoria, uid)
  const nueva: CpuPrevia = new Map()
  const cpus = new Map<number, number>()
  for (const f of filas) {
    if (f.uid !== uid) continue
    nueva.set(f.pid, { inicio: f.inicio, cpuSeg: f.cpuSeg, t: ahora })
    cpus.set(f.pid, cpuReal(f, previa, ahora))
  }

  const porClave = new Map<string, MuestraSesion>()
  const clavePorRaiz = new Map<string, string>()
  for (const { fila: f, clave } of a.raices) {
    const s = { clave: `s${f.pid}`, nombre: nombres.get(f.pid) ?? 'claude', cpu: cpus.get(f.pid) ?? 0, rssKb: f.rssKb }
    porClave.set(s.clave, s)
    clavePorRaiz.set(clave, s.clave)
  }
  for (const [pid, sesion] of a.dueno) {
    const s = porClave.get(clavePorRaiz.get(sesion) ?? '')
    const f = a.porPid.get(pid)
    if (!s || !f) continue
    s.cpu += cpus.get(pid) ?? 0
    s.rssKb += f.rssKb
  }
  let huerfanosCpu = 0
  let huerfanosRssKb = 0
  for (const pid of a.huerfanos.keys()) {
    huerfanosCpu += cpus.get(pid) ?? 0
    huerfanosRssKb += a.porPid.get(pid)?.rssKb ?? 0
  }

  const sesiones = [...porClave.values()].map((s) => ({ ...s, cpu: redondear(s.cpu) }))
  return {
    muestra: { t: ahora, sesiones, huerfanosCpu: redondear(huerfanosCpu), huerfanosRssKb },
    previa: nueva
  }
}

/**
 * Agrega una muestra, descarta las que salieron de la ventana y le da color a las sesiones nuevas:
 * el índice libre más bajo. Un color se libera solo cuando su sesión ya no aparece en ninguna
 * muestra de la ventana, para que dos sesiones nunca compartan color en la misma gráfica. Si no
 * queda ninguno, la sesión va a «Otras» (-1) y se queda ahí.
 */
export function agregarMuestra(h: Historial, m: Muestra): Historial {
  const muestras = [...h.muestras.filter((x) => m.t - x.t <= VENTANA_MS && x.t < m.t), m]
  const presentes = new Set(muestras.flatMap((x) => x.sesiones.map((s) => s.clave)))
  const colores: Record<string, number> = {}
  for (const [clave, color] of Object.entries(h.colores)) if (presentes.has(clave)) colores[clave] = color
  const nuevas = m.sesiones.filter((s) => !(s.clave in colores)).sort((x, y) => y.rssKb - x.rssKb)
  for (const s of nuevas) {
    const usados = new Set(Object.values(colores))
    let libre = -1
    for (let i = 0; i < COLORES_SESION; i++) {
      if (!usados.has(i)) {
        libre = i
        break
      }
    }
    colores[s.clave] = libre
  }
  return { muestras, colores, intervaloMs: h.intervaloMs }
}
