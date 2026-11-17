// Del historial a series apiladas para las gráficas. Puro: lo usa el panel y se prueba en Node.
import { decimal } from './formato'
import { t as textos } from './i18n'
import type { Historial } from './tipos'

/** Índice de paleta (0–4), «otras» o «huerfanos». */
export type ColorSerie = number | 'otras' | 'huerfanos'

export type Serie = { clave: string; nombre: string; color: ColorSerie; valores: number[] }

/** `series` va de abajo hacia arriba en la pila: huérfanos, las sesiones por color, «Otras». */
export type Datos = { t: number[]; series: Serie[] }

export type Medida = 'cpu' | 'rssKb'

export function construirSeries(h: Historial, desde: number, medida: Medida): Datos {
  const muestras = h.muestras.filter((m) => m.t >= desde)
  const t = muestras.map((m) => m.t)
  const nombres = new Map<string, string>()
  for (const m of muestras) for (const s of m.sesiones) nombres.set(s.clave, s.nombre)

  const conColor = [...nombres.keys()]
    .filter((c) => (h.colores[c] ?? -1) >= 0)
    .sort((a, b) => h.colores[a] - h.colores[b])
  const otras = [...nombres.keys()].filter((c) => (h.colores[c] ?? -1) < 0)

  const series: Serie[] = []
  const huerfanos = muestras.map((m) => (medida === 'cpu' ? m.huerfanosCpu : m.huerfanosRssKb))
  if (huerfanos.some((v) => v > 0)) series.push({ clave: 'huerfanos', nombre: textos().actividad.huerfanosSerie, color: 'huerfanos', valores: huerfanos })
  for (const clave of conColor) {
    series.push({
      clave,
      nombre: nombres.get(clave)!,
      color: h.colores[clave],
      valores: muestras.map((m) => m.sesiones.find((s) => s.clave === clave)?.[medida] ?? 0)
    })
  }
  if (otras.length) {
    series.push({
      clave: 'otras',
      nombre: otras.length === 1 ? nombres.get(otras[0])! : textos().actividad.otrasSesiones(otras.length),
      color: 'otras',
      valores: muestras.map((m) =>
        m.sesiones.filter((s) => otras.includes(s.clave)).reduce((n, s) => n + s[medida], 0)
      )
    })
  }
  return { t, series }
}

/** La suma acumulada de cada serie, muestra por muestra: el borde superior de cada banda. */
export function apilar(series: readonly Serie[]): number[][] {
  const acumulado: number[][] = []
  let debajo: number[] = series[0]?.valores.map(() => 0) ?? []
  for (const s of series) {
    const arriba = s.valores.map((v, i) => debajo[i] + v)
    acumulado.push(arriba)
    debajo = arriba
  }
  return acumulado
}

/** Marcas redondas (1, 2 o 5 × 10ⁿ) desde 0 hasta cubrir `max`, unas `n`. */
export function marcas(max: number, n = 3): number[] {
  const tope = Math.max(max, 1e-9)
  const crudo = tope / n
  const potencia = 10 ** Math.floor(Math.log10(crudo))
  const paso = [1, 2, 5, 10].map((k) => k * potencia).find((p) => p >= crudo) ?? 10 * potencia
  const res: number[] = []
  for (let v = 0; v < tope + paso * 0.999; v += paso) res.push(Number(v.toPrecision(12)))
  return res
}

/** Marcas de memoria (en KB) que caen en MB o GB redondos: 0, 500 MB, 1 GB… */
export function marcasMemoria(maxKb: number, n = 3): number[] {
  const mb = maxKb / 1024
  if (mb >= 1024) return marcas(mb / 1024, n).map((g) => g * 1024 * 1024)
  return marcas(Math.max(mb, 1), n).map((m) => m * 1024)
}

/** Etiqueta de eje para memoria: "0", "500 MB", "1.5 GB" ("1,5 GB" en español). */
export function etiquetaMemoria(kb: number): string {
  if (kb === 0) return '0'
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb : decimal(gb, 1)} GB`
}

/** El índice de la muestra más cercana a `t`. */
export function masCercana(t: readonly number[], objetivo: number): number {
  let mejor = 0
  for (let i = 1; i < t.length; i++) if (Math.abs(t[i] - objetivo) < Math.abs(t[mejor] - objetivo)) mejor = i
  return mejor
}
