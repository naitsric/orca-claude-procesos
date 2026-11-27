// Lógica pura del historial que alimenta las gráficas: una muestra liviana (solo ps) cada pocos
// segundos, la CPU real entre muestras y un color fijo por sesión.
import { agrupar, mismoProceso, type Fila, type Memoria } from './procesos'
import type { Historial, Muestra, MuestraSesion } from './tipos'

export const INTERVALO_MUESTRA_MS = 5000
/** Lo que guardan las gráficas: media hora. */
export const VENTANA_MS = 30 * 60_000
/** Colores de sesión en la paleta; la sexta sesión en adelante va a «Otras». */
export const COLORES_SESION = 5

/** Orca rechaza guardar un valor de más de 256 KiB (lo mide como el JSON compacto en UTF-8). */
export const LIMITE_VALOR_BYTES = 262144
/** Lo más que ocupa el historial al guardarlo o mandarlo a un panel, con margen bajo ese límite. */
export const LIMITE_HISTORIAL_BYTES = 240_000

/** La última lectura de CPU acumulada de cada proceso, para calcular el uso entre muestras. */
export type CpuPrevia = Map<number, { inicio: number; cpuSeg: number; t: number }>

export function historialVacio(): Historial {
  return { muestras: [], colores: {}, intervaloMs: INTERVALO_MUESTRA_MS }
}

const esNumero = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Una muestra guardada, o null si no tiene la forma esperada. Las sesiones mal formadas se descartan. */
function leerMuestra(valor: unknown): Muestra | null {
  const m = valor as Partial<Muestra> | null
  if (!m || !esNumero(m.t) || !Array.isArray(m.sesiones)) return null
  const sesiones = m.sesiones.filter(
    (s) => s && typeof s.clave === 'string' && typeof s.nombre === 'string' && esNumero(s.cpu) && esNumero(s.rssKb)
  )
  return {
    t: m.t,
    sesiones,
    huerfanosCpu: esNumero(m.huerfanosCpu) ? m.huerfanosCpu : 0,
    huerfanosRssKb: esNumero(m.huerfanosRssKb) ? m.huerfanosRssKb : 0,
    ...(esNumero(m.ms) && m.ms > 0 ? { ms: m.ms } : {})
  }
}

/** El historial guardado, sin lo que ya salió de la ventana ni lo que no tenga la forma esperada. */
export function leerHistorial(valor: unknown, ahora: number): Historial {
  const h = valor as Partial<Historial> | null
  if (!h || !Array.isArray(h.muestras) || typeof h.colores !== 'object' || h.colores === null) return historialVacio()
  const muestras = h.muestras
    .map(leerMuestra)
    .filter((m): m is Muestra => m !== null && ahora - m.t <= VENTANA_MS)
    .sort((a, b) => a.t - b.t)
  const presentes = new Set(muestras.flatMap((m) => m.sesiones.map((s) => s.clave)))
  const colores: Record<string, number> = {}
  for (const [clave, color] of Object.entries(h.colores)) if (presentes.has(clave) && esNumero(color)) colores[clave] = color
  return { muestras, colores, intervaloMs: INTERVALO_MUESTRA_MS }
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

// ---------------------------------------------------------------------------------------------
// El tamaño: una muestra pesa unos 65 bytes por sesión, así que media hora (360 muestras) con
// más de diez sesiones abiertas no cabe en un valor de storage. Lo que no cabe se resume.

const codificador = new TextEncoder()

/** Lo que ocupa un valor como lo mide Orca al guardarlo: su JSON compacto, en bytes UTF-8. */
export function pesoEnBytes(valor: unknown): number {
  const json = JSON.stringify(valor)
  return json === undefined ? 0 : codificador.encode(json).length
}

/** Los milisegundos que cubre una muestra: los de su resumen, o el intervalo entre muestras. */
const cubre = (m: Muestra): number => m.ms ?? INTERVALO_MUESTRA_MS

/** Varias muestras seguidas en una: el promedio de cada sesión mientras estuvo, pesado por lo
 *  que cubre cada muestra, con la hora de la última. */
function fundir(grupo: readonly Muestra[]): Muestra {
  if (grupo.length === 1) return grupo[0]
  const sesiones = new Map<string, { nombre: string; cpu: number; rssKb: number; peso: number }>()
  let huerfanosCpu = 0
  let huerfanosRssKb = 0
  let total = 0
  for (const m of grupo) {
    const peso = cubre(m)
    total += peso
    huerfanosCpu += m.huerfanosCpu * peso
    huerfanosRssKb += m.huerfanosRssKb * peso
    for (const s of m.sesiones) {
      const a = sesiones.get(s.clave) ?? { nombre: s.nombre, cpu: 0, rssKb: 0, peso: 0 }
      a.nombre = s.nombre
      a.cpu += s.cpu * peso
      a.rssKb += s.rssKb * peso
      a.peso += peso
      sesiones.set(s.clave, a)
    }
  }
  return {
    t: grupo[grupo.length - 1].t,
    sesiones: [...sesiones].map(([clave, a]) => ({
      clave,
      nombre: a.nombre,
      cpu: redondear(a.cpu / a.peso),
      rssKb: Math.round(a.rssKb / a.peso)
    })),
    huerfanosCpu: redondear(huerfanosCpu / total),
    huerfanosRssKb: Math.round(huerfanosRssKb / total),
    ms: total
  }
}

/** Una muestra por cada tramo de `anchoMs` del reloj. Los tramos no dependen de cuándo se
 *  resume: resumir otra vez con el mismo ancho deja las muestras como están. */
export function resumir(muestras: readonly Muestra[], anchoMs: number): Muestra[] {
  const grupos = new Map<number, Muestra[]>()
  for (const m of muestras) {
    const tramo = Math.floor(m.t / anchoMs)
    const grupo = grupos.get(tramo)
    if (grupo) grupo.push(m)
    else grupos.set(tramo, [m])
  }
  return [...grupos.values()].map(fundir)
}

/**
 * El historial tal como cabe en `limite` bytes. Si ya cabe, el mismo. Si no, con menos detalle
 * pero sin perder la media hora: una muestra cada 10 s, 20 s, 40 s… hasta que quepa. Con tantas
 * sesiones que ni así cabe, las muestras más nuevas que quepan. Nunca devuelve más de `limite`.
 */
export function ajustarHistorial(h: Historial, limite = LIMITE_HISTORIAL_BYTES): Historial {
  if (pesoEnBytes(h) <= limite) return h
  let muestras = h.muestras
  for (let ancho = INTERVALO_MUESTRA_MS * 2; ancho <= VENTANA_MS; ancho *= 2) {
    muestras = resumir(h.muestras, ancho)
    const resumido = { ...h, muestras }
    if (pesoEnBytes(resumido) <= limite) return resumido
  }
  for (let desde = 1; desde <= muestras.length; desde++) {
    const quedan = muestras.slice(desde)
    const presentes = new Set(quedan.flatMap((m) => m.sesiones.map((s) => s.clave)))
    const colores = Object.fromEntries(Object.entries(h.colores).filter(([clave]) => presentes.has(clave)))
    const recortado = { ...h, muestras: quedan, colores }
    if (pesoEnBytes(recortado) <= limite) return recortado
  }
  return historialVacio()
}
