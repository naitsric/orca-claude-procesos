// El historial de las gráficas: CPU real entre muestras, colores fijos por sesión y series apiladas.
import { assert, test } from 'orca/testing'
import { AHORA, COMM, memoriaConSesionMuerta, PS, UID } from './fixtures'
import { agregarMuestra, historialVacio, tomarMuestra, VENTANA_MS, type CpuPrevia } from './historial'
import { parsearPs, segundosDeTiempo } from './procesos'
import { apilar, construirSeries, etiquetaMemoria, marcas, marcasMemoria, masCercana } from './series'
import type { Historial, Muestra } from './tipos'

test('lee el tiempo de CPU acumulado de ps', () => {
  assert.equal(segundosDeTiempo('0:12.50'), 12.5)
  assert.equal(segundosDeTiempo('12:00.00'), 720)
  assert.equal(segundosDeTiempo('1:02:03.00'), 3723)
  assert.equal(segundosDeTiempo('1-00:00:00.00'), 86400)
})

test('la CPU de una muestra es el uso real desde la anterior, sumado por sesión', () => {
  const filas = parsearPs(PS, COMM, AHORA)
  const previa: CpuPrevia = new Map()
  // Hace 5 s la sesión y su mcp-grafana llevaban 1 s y 2 s menos de CPU que ahora.
  const claude = filas.find((f) => f.pid === 4129)!
  const grafana = filas.find((f) => f.pid === 4281)!
  previa.set(4129, { inicio: claude.inicio, cpuSeg: claude.cpuSeg - 1, t: AHORA - 5000 })
  previa.set(4281, { inicio: grafana.inicio, cpuSeg: grafana.cpuSeg - 2, t: AHORA - 5000 })
  for (const f of filas) if (!previa.has(f.pid)) previa.set(f.pid, { inicio: f.inicio, cpuSeg: f.cpuSeg, t: AHORA - 5000 })

  const { muestra } = tomarMuestra(filas, memoriaConSesionMuerta(), UID, previa, new Map([[4129, 'mi-app-c7']]), AHORA)
  assert.equal(muestra.sesiones.length, 1)
  const s = muestra.sesiones[0]
  assert.equal(s.clave, 's4129')
  assert.equal(s.nombre, 'mi-app-c7')
  assert.equal(s.cpu, 60, '(1 s + 2 s) en 5 s = 60 %')
  assert.equal(s.rssKb, 400000 + 20000 + 15000 + 15000 + 1000 + 1000 + 80000)
  assert.equal(muestra.huerfanosRssKb, 15000 + 30000 + 5000 + 9000 + 20000)
})

test('sin lectura anterior usa el %CPU de ps', () => {
  const filas = parsearPs(PS, COMM, AHORA)
  const { muestra } = tomarMuestra(filas, memoriaConSesionMuerta(), UID, new Map(), new Map(), AHORA)
  assert.equal(muestra.sesiones[0].cpu, 3, 'el 3.0 % de claude; el resto está en 0')
})

function muestra(t: number, sesiones: [string, number][]): Muestra {
  return { t, sesiones: sesiones.map(([clave, rssKb]) => ({ clave, nombre: clave, cpu: 1, rssKb })), huerfanosCpu: 0, huerfanosRssKb: 0 }
}

test('cada sesión nueva toma el color libre más bajo y lo conserva', () => {
  let h: Historial = historialVacio()
  h = agregarMuestra(h, muestra(1000, [['s1', 10], ['s2', 30]]))
  assert.deepEqual(h.colores, { s2: 0, s1: 1 }, 'las nuevas, de mayor a menor memoria')
  h = agregarMuestra(h, muestra(2000, [['s1', 50], ['s3', 5]]))
  assert.deepEqual(h.colores, { s2: 0, s1: 1, s3: 2 }, 's2 cerró pero sigue en la gráfica: su color no se presta')
  assert.equal(h.colores.s1, 1, 'pasar a ser la más grande no le cambia el color')
})

test('un color se libera cuando su sesión sale de la ventana', () => {
  let h: Historial = historialVacio()
  h = agregarMuestra(h, muestra(0, [['viejo', 10]]))
  h = agregarMuestra(h, muestra(VENTANA_MS + 1000, [['nuevo', 10]]))
  assert.equal(h.colores.viejo, undefined)
  assert.equal(h.colores.nuevo, 0)
  assert.equal(h.muestras.length, 1)
})

test('la sexta sesión va a «Otras» y no cambia de color después', () => {
  let h: Historial = historialVacio()
  h = agregarMuestra(h, muestra(1000, [['a', 6], ['b', 5], ['c', 4], ['d', 3], ['e', 2], ['f', 1]]))
  assert.equal(h.colores.f, -1)
  h = agregarMuestra(h, muestra(2000, [['f', 99]]))
  assert.equal(h.colores.f, -1)
})

test('las series van de abajo hacia arriba: huérfanos, sesiones por color, otras', () => {
  let h: Historial = historialVacio()
  h = agregarMuestra(h, muestra(1000, [['a', 6], ['b', 5], ['c', 4], ['d', 3], ['e', 2], ['f', 1]]))
  h = agregarMuestra(h, { ...muestra(2000, [['a', 6], ['f', 1]]), huerfanosRssKb: 7 })
  const datos = construirSeries(h, 0, 'rssKb')
  assert.deepEqual(datos.series.map((s) => s.clave), ['huerfanos', 'a', 'b', 'c', 'd', 'e', 'otras'])
  assert.deepEqual(datos.series[0].valores, [0, 7])
  assert.deepEqual(datos.series.find((s) => s.clave === 'b')!.valores, [5, 0], 'cero donde la sesión ya no estaba')
  assert.equal(datos.series.at(-1)!.nombre, 'f', 'una sola sesión en «Otras» lleva su nombre')
  const pilas = apilar(datos.series)
  assert.deepEqual(pilas.at(-1), [21, 14])
})

test('marcas redondas y la muestra más cercana', () => {
  assert.deepEqual(marcas(38, 3), [0, 20, 40])
  assert.deepEqual(marcas(100, 3), [0, 50, 100])
  assert.deepEqual(marcas(7, 3), [0, 5, 10])
  assert.equal(masCercana([0, 5000, 10000], 6000), 1)
})

test('el eje de memoria cae en MB o GB redondos', () => {
  const gb = 1024 * 1024
  assert.deepEqual(marcasMemoria(1.6 * gb, 3).map(etiquetaMemoria), ['0', '1 GB', '2 GB'])
  assert.deepEqual(marcasMemoria(700 * 1024, 3).map(etiquetaMemoria), ['0', '500 MB', '1000 MB'])
  assert.equal(etiquetaMemoria(1.5 * gb), '1,5 GB')
})
