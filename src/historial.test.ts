// El historial de las gráficas: CPU real entre muestras, colores fijos por sesión y series apiladas.
import { assert, test } from 'orca/testing'
import { AHORA, COMM, memoriaConSesionMuerta, PS, UID } from './fixtures'
import {
  agregarMuestra,
  ajustarHistorial,
  historialVacio,
  INTERVALO_MUESTRA_MS,
  leerHistorial,
  LIMITE_HISTORIAL_BYTES,
  LIMITE_VALOR_BYTES,
  pesoEnBytes,
  resumir,
  tomarMuestra,
  VENTANA_MS,
  type CpuPrevia
} from './historial'
import { parsearPs, segundosDeTiempo } from './procesos'
import { apilar, construirSeries, etiquetaMemoria, marcas, marcasMemoria, masCercana, tramosSinHuecos } from './series'
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
  assert.equal(etiquetaMemoria(1.5 * gb), '1.5 GB')
})

// ---------------------------------------------------------------------------------------------
// El límite de storage: Orca rechaza un valor de más de 256 KiB.

/** Media hora de muestras, una cada 5 s, con `n` sesiones abiertas todo el tiempo. */
function mediaHora(n: number, hasta: number): Historial {
  let h: Historial = historialVacio()
  for (let t = hasta - VENTANA_MS; t <= hasta; t += INTERVALO_MUESTRA_MS) {
    h = agregarMuestra(h, {
      t,
      sesiones: Array.from({ length: n }, (_, i) => ({ clave: `s${70000 + i}`, nombre: `proyecto-${i}`, cpu: 12.5, rssKb: 400000 + i })),
      huerfanosCpu: 1.5,
      huerfanosRssKb: 30000
    })
  }
  return h
}

test('un historial que cabe se guarda tal cual', () => {
  const h = mediaHora(3, 1_800_000_000_000)
  assert.ok(pesoEnBytes(h) < LIMITE_HISTORIAL_BYTES)
  assert.equal(ajustarHistorial(h), h)
})

test('media hora con muchas sesiones pasaría de 256 KiB: se guarda resumida, bajo el límite y sin perder la media hora', () => {
  const hasta = 1_800_000_000_000
  for (const n of [15, 40, 150]) {
    const h = mediaHora(n, hasta)
    assert.ok(pesoEnBytes(h) > LIMITE_VALOR_BYTES, `${n} sesiones: entero no cabe`)
    const a = ajustarHistorial(h)
    assert.ok(pesoEnBytes(a) <= LIMITE_HISTORIAL_BYTES, `${n} sesiones: ${pesoEnBytes(a)} bytes`)
    assert.ok(LIMITE_HISTORIAL_BYTES < LIMITE_VALOR_BYTES)
    assert.equal(h.muestras.length, 361, 'el historial en memoria queda entero')
    assert.equal(a.muestras.at(-1)!.t, hasta, 'la última muestra sigue siendo la más nueva')
    assert.ok(a.muestras[0].t - (hasta - VENTANA_MS) < a.muestras[0].ms!, 'y la primera, del comienzo de la media hora')
    assert.equal(a.muestras.reduce((ms, m) => ms + (m.ms ?? INTERVALO_MUESTRA_MS), 0), 361 * INTERVALO_MUESTRA_MS, 'cada muestra original quedó en alguna')
    assert.ok(a.muestras.every((m) => m.sesiones.length === n), 'con todas las sesiones')
    assert.deepEqual(a.muestras[1].sesiones[0], { clave: 's70000', nombre: 'proyecto-0', cpu: 12.5, rssKb: 400000 })
    assert.equal(a.muestras[1].huerfanosCpu, 1.5)
    assert.deepEqual(a.colores, h.colores)
    assert.equal(tramosSinHuecos(construirSeries(a, 0, 'cpu')).length, 1, 'la gráfica no se corta por ir resumida')
  }
})

test('15 sesiones caben con una muestra cada 10 s', () => {
  const a = ajustarHistorial(mediaHora(15, 1_800_000_000_000))
  assert.equal(a.muestras.length, 181)
  assert.ok(a.muestras.slice(0, -1).every((m) => m.ms === 10_000))
  assert.equal(a.muestras.at(-1)!.ms, undefined, 'la última va sola en su tramo')
})

test('lo resumido se puede volver a cargar, seguir llenando y resumir otra vez sin pasar del límite', () => {
  let hasta = 1_800_000_000_000
  const guardado = JSON.parse(JSON.stringify(ajustarHistorial(mediaHora(15, hasta)))) as unknown
  let h = leerHistorial(guardado, hasta)
  assert.deepEqual(h, ajustarHistorial(mediaHora(15, hasta)))
  // Otros diez minutos de muestras cada 5 s sobre lo que se cargó resumido.
  const ultima = h.muestras.at(-1)!
  for (let i = 0; i < 120; i++) {
    hasta += INTERVALO_MUESTRA_MS
    h = agregarMuestra(h, { ...ultima, t: hasta })
  }
  const a = ajustarHistorial(h)
  assert.ok(pesoEnBytes(h) > LIMITE_HISTORIAL_BYTES)
  assert.ok(pesoEnBytes(a) <= LIMITE_HISTORIAL_BYTES)
  assert.ok(a.muestras.every((m) => (m.ms ?? INTERVALO_MUESTRA_MS) <= 10_000), 'sigue a 10 s: lo ya resumido no se vuelve a fundir')
  assert.equal(ajustarHistorial(a), a)
})

test('resumir promedia cada sesión mientras estuvo, pesando lo que cubre cada muestra', () => {
  const m = (t: number, sesiones: [string, number, number][], ms?: number): Muestra => ({
    t,
    sesiones: sesiones.map(([clave, cpu, rssKb]) => ({ clave, nombre: clave, cpu, rssKb })),
    huerfanosCpu: sesiones.length,
    huerfanosRssKb: 100 * sesiones.length,
    ...(ms ? { ms } : {})
  })
  const r = resumir([m(20_000, [['a', 10, 100], ['b', 40, 400]]), m(25_000, [['a', 30, 300]]), m(30_000, [['a', 1, 1]])], 10_000)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], {
    t: 25_000,
    sesiones: [
      { clave: 'a', nombre: 'a', cpu: 20, rssKb: 200 },
      { clave: 'b', nombre: 'b', cpu: 40, rssKb: 400 }
    ],
    huerfanosCpu: 1.5,
    huerfanosRssKb: 150,
    ms: 10_000
  })
  assert.deepEqual(r[1], m(30_000, [['a', 1, 1]]), 'una muestra sola en su tramo queda igual')
  // Una ya resumida (10 s) pesa el doble que una suelta (5 s).
  const [dos] = resumir([m(25_000, [['a', 30, 300]], 10_000), m(30_000, [['a', 0, 0]])], 20_000)
  assert.deepEqual(dos.sesiones, [{ clave: 'a', nombre: 'a', cpu: 20, rssKb: 200 }])
  assert.equal(dos.ms, 15_000)
})

test('con tantas sesiones que ni resumido cabe, quedan las muestras más nuevas que quepan', () => {
  const hasta = 1_800_000_000_000
  const sesiones = Array.from({ length: 1500 }, (_, i) => ({ clave: `s${i}`, nombre: `proyecto-${i}`, cpu: 1, rssKb: 1000 }))
  let h: Historial = historialVacio()
  for (let i = 5; i >= 0; i--) h = agregarMuestra(h, { t: hasta - i * 300_000, sesiones, huerfanosCpu: 0, huerfanosRssKb: 0 })
  const a = ajustarHistorial(h)
  assert.ok(pesoEnBytes(a) <= LIMITE_HISTORIAL_BYTES)
  assert.ok(a.muestras.length >= 1 && a.muestras.length < 6)
  assert.equal(a.muestras.at(-1)!.t, hasta)

  // Ni una sola muestra cabe: no se guarda ninguna, pero tampoco se pasa del límite.
  const enorme = agregarMuestra(historialVacio(), {
    t: hasta,
    sesiones: Array.from({ length: 6000 }, (_, i) => ({ clave: `s${i}`, nombre: `proyecto-${i}`, cpu: 1, rssKb: 1000 })),
    huerfanosCpu: 0,
    huerfanosRssKb: 0
  })
  assert.ok(pesoEnBytes(enorme) > LIMITE_VALOR_BYTES)
  assert.deepEqual(ajustarHistorial(enorme), historialVacio())
})

test('el peso es el de los bytes en UTF-8, como lo mide Orca', () => {
  assert.equal(pesoEnBytes({ nombre: 'año' }), 17)
  const h = agregarMuestra(historialVacio(), muestra(1000, [['sesión-ñandú', 10]]))
  assert.ok(pesoEnBytes(h) > JSON.stringify(h).length)
})

test('al leer lo guardado descarta lo que salió de la ventana y lo que no tiene forma de muestra', () => {
  const ahora = 1_800_000_000_000
  const buena = muestra(ahora - 5000, [['s1', 10]])
  const h = leerHistorial(
    {
      muestras: [
        muestra(ahora - VENTANA_MS - 1000, [['viejo', 10]]),
        null,
        { t: 'ayer', sesiones: [] },
        { t: ahora - 1000, sesiones: [{ clave: 's1', nombre: 's1', cpu: 2, rssKb: 20 }, { clave: 7 }, null], ms: 10_000 },
        buena
      ],
      colores: { s1: 0, viejo: 1, raro: 'azul' }
    },
    ahora
  )
  assert.deepEqual(h.muestras, [
    buena,
    { t: ahora - 1000, sesiones: [{ clave: 's1', nombre: 's1', cpu: 2, rssKb: 20 }], huerfanosCpu: 0, huerfanosRssKb: 0, ms: 10_000 }
  ])
  assert.deepEqual(h.colores, { s1: 0 })
  assert.deepEqual(leerHistorial('basura', ahora), historialVacio())
  assert.deepEqual(leerHistorial({ muestras: 3, colores: {} }, ahora), historialVacio())
})

test('la gráfica se corta donde el worker estuvo parado, también entre muestras resumidas', () => {
  assert.deepEqual(tramosSinHuecos({ t: [0, 5000, 10_000, 30_000, 35_000], cubre: [5000, 5000, 5000, 5000, 5000] }), [[0, 2], [3, 4]])
  assert.deepEqual(tramosSinHuecos({ t: [0, 20_000, 40_000, 45_000], cubre: [20_000, 20_000, 20_000, 5000] }), [[0, 3]])
  assert.deepEqual(tramosSinHuecos({ t: [0, 20_000, 90_000], cubre: [20_000, 20_000, 20_000] }), [[0, 1], [2, 2]])
  assert.deepEqual(tramosSinHuecos({ t: [], cubre: [] }), [])
})
