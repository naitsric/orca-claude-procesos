// El límite de storage para la memoria: Orca rechaza un valor de más de 256 KiB, y sin memoria
// guardada la revisión entera falla.
import { assert, test } from 'orca/testing'
import { AHORA, memoriaConSesionMuerta, revisarFixture } from './fixtures'
import { LIMITE_VALOR_BYTES, pesoEnBytes } from './historial'
import { ajustarMemoria, LIMITE_MEMORIA_BYTES } from './memoria'
import { memoriaVacia, type Memoria } from './procesos'

const UN_DIA = 24 * 3600_000

type SesionRecordada = Memoria['sesiones'][string]

/** Una sesión como las que el plugin recuerda: la `i`, que terminó en `termino` (null si vive). */
function sesion(i: number, termino: number | null): [string, SesionRecordada] {
  const inicio = (termino ?? AHORA) - 2 * 3600_000
  const pid = 10_000 + i
  return [
    `${pid}@${Math.round(inicio / 1000)}`,
    {
      pid,
      inicio,
      pgid: pid,
      cwd: `/Users/u/orca/workspaces/proyecto-${i % 40}/tarea-${i}`,
      nombre: `tarea-${i}`,
      vista: termino ?? AHORA,
      termino
    }
  ]
}

/** `n` sesiones que terminaron a lo largo de la última semana: la 0 es la más vieja. */
function memoriaCon(n: number): Memoria {
  const m = memoriaVacia()
  for (let i = 0; i < n; i++) {
    const [clave, s] = sesion(i, AHORA - 7 * UN_DIA + Math.round(((i + 1) * 7 * UN_DIA) / (n + 1)))
    m.sesiones[clave] = s
  }
  return m
}

const claves = (m: Memoria): string[] => Object.keys(m.sesiones)

test('lo que se recuerda hoy cabe con margen: se guarda entero', () => {
  // Lo medido en uso real: 120 sesiones en una semana, unos 27 KB.
  const m = memoriaCon(120)
  assert.ok(pesoEnBytes(m) < 40_000, `${pesoEnBytes(m)} bytes`)
  assert.equal(ajustarMemoria(m), m, 'la misma, sin tocar')
  assert.ok(LIMITE_MEMORIA_BYTES < LIMITE_VALOR_BYTES)
  // Hasta mil sesiones en una semana siguen cabiendo enteras.
  const mil = memoriaCon(1000)
  assert.equal(ajustarMemoria(mil), mil, `${pesoEnBytes(mil)} bytes`)
})

test('con miles de sesiones pasaría de 256 KiB: se guarda sin las más viejas, bajo el límite', () => {
  for (const n of [1500, 3000, 20_000]) {
    const m = memoriaCon(n)
    assert.ok(pesoEnBytes(m) > LIMITE_VALOR_BYTES, `${n} sesiones: entera no cabe`)
    const a = ajustarMemoria(m)
    assert.ok(pesoEnBytes(a) <= LIMITE_MEMORIA_BYTES, `${n} sesiones: ${pesoEnBytes(a)} bytes`)
    const quedan = claves(a)
    assert.ok(quedan.length > 1000, `${n} sesiones: quedan ${quedan.length}`)
    assert.deepEqual(quedan, claves(m).slice(n - quedan.length), 'quedan las más nuevas, todas seguidas')
    // Las menos que hace falta: con una más ya no cabría.
    const unaMas = { ...a, sesiones: Object.fromEntries(Object.entries(m.sesiones).slice(n - quedan.length - 1)) }
    assert.ok(pesoEnBytes(unaMas) > LIMITE_MEMORIA_BYTES)
    assert.equal(m.sesiones[claves(m)[0]].pid, 10_000, 'la memoria que recibe no se toca')
    assert.equal(claves(m).length, n)
  }
})

test('ajustar otra vez deja la memoria como está', () => {
  const a = ajustarMemoria(memoriaCon(3000))
  assert.equal(ajustarMemoria(a), a)
})

test('olvida primero las sesiones terminadas sin procesos vivos, después las que dejaron alguno, y al final las vivas', () => {
  const m = memoriaVacia()
  const poner = (i: number, termino: number | null): string => {
    const [clave, s] = sesion(i, termino)
    m.sesiones[clave] = s
    return clave
  }
  // La más vieja de todas dejó un servidor corriendo; las demás terminadas, nada.
  const conHuerfano = poner(0, AHORA - 6 * UN_DIA)
  m.grupos['20000'] = { sesion: conHuerfano, inicio: AHORA - 6 * UN_DIA }
  m.linaje['20001'] = { sesion: conHuerfano, inicio: AHORA - 6 * UN_DIA }
  const terminadas = Array.from({ length: 10 }, (_, i) => poner(1 + i, AHORA - (5 - i * 0.4) * UN_DIA))
  const viva = poner(50, null)
  m.grupos['10050'] = { sesion: viva, inicio: m.sesiones[viva].inicio }
  m.linaje['30000'] = { sesion: viva, inicio: AHORA - 3600_000 }

  const entera = pesoEnBytes(m)
  const sinTres = ajustarMemoria(m, entera - 2 * 230)
  assert.deepEqual(claves(sinTres), [conHuerfano, ...terminadas.slice(3), viva], 'se van las tres terminadas más viejas')
  assert.ok(sinTres.grupos['20000'] && sinTres.linaje['20001'], 'el huérfano sigue con su sesión')

  const sinTerminadas = ajustarMemoria(m, pesoEnBytes({ ...m, sesiones: { [conHuerfano]: m.sesiones[conHuerfano], [viva]: m.sesiones[viva] } }))
  assert.deepEqual(claves(sinTerminadas), [conHuerfano, viva])

  const soloViva = ajustarMemoria(m, pesoEnBytes(sinTerminadas) - 1)
  assert.deepEqual(claves(soloViva), [viva], 'después, la terminada que dejó procesos')
  assert.deepEqual(Object.keys(soloViva.grupos), ['10050'], 'con sus grupos')
  assert.deepEqual(Object.keys(soloViva.linaje), ['30000'], 'y su linaje')

  assert.deepEqual(ajustarMemoria(m, pesoEnBytes(soloViva) - 1), memoriaVacia(), 'y si ni así, vacía')
})

test('nunca devuelve más que el límite, quepa lo que quepa', () => {
  // Una sola sesión que no cabe (un nombre enorme), entre otras que sí.
  const gorda = memoriaCon(50)
  const [clave, s] = sesion(99, AHORA - 60_000)
  gorda.sesiones[clave] = { ...s, nombre: 'ñ'.repeat(200_000) }
  assert.ok(pesoEnBytes(gorda) > LIMITE_VALOR_BYTES, 'los bytes se cuentan en UTF-8')
  const sinLaGorda = ajustarMemoria(gorda)
  assert.ok(pesoEnBytes(sinLaGorda) <= LIMITE_MEMORIA_BYTES)
  assert.equal(sinLaGorda.sesiones[clave], undefined)

  // Miles de procesos vivos bajo una sola sesión: el linaje solo ya no cabe.
  const viva = memoriaVacia()
  const [claveViva, v] = sesion(1, null)
  viva.sesiones[claveViva] = v
  for (let pid = 40_000; pid < 46_000; pid++) viva.linaje[String(pid)] = { sesion: claveViva, inicio: AHORA - pid }
  assert.ok(pesoEnBytes(viva) > LIMITE_VALOR_BYTES)
  assert.deepEqual(ajustarMemoria(viva), memoriaVacia())

  // Grupos y linaje de sesiones que ya no están en la memoria no se guardan.
  const sueltos = memoriaVacia()
  for (let pid = 40_000; pid < 46_000; pid++) sueltos.linaje[String(pid)] = { sesion: 'no-esta@1', inicio: AHORA - pid }
  assert.deepEqual(ajustarMemoria(sueltos), memoriaVacia())

  const m = memoriaCon(400)
  for (const limite of [0, 46, 300, 1000, 20_000, 60_000]) {
    const a = ajustarMemoria(m, limite)
    assert.ok(pesoEnBytes(a) <= Math.max(limite, pesoEnBytes(memoriaVacia())), `límite ${limite}: ${pesoEnBytes(a)} bytes`)
  }
})

test('con la memoria recortada, el huérfano de una sesión terminada sigue siendo seguro', () => {
  // La sesión 5000 murió hace una hora y dejó su mcp-grafana; antes hubo miles de sesiones más.
  const m = memoriaCon(3000)
  const muerta = memoriaConSesionMuerta()
  Object.assign(m.sesiones, muerta.sesiones)
  Object.assign(m.grupos, muerta.grupos)
  assert.ok(pesoEnBytes(m) > LIMITE_VALOR_BYTES)
  const a = ajustarMemoria(m)
  assert.ok(pesoEnBytes(a) <= LIMITE_MEMORIA_BYTES)
  assert.ok(a.sesiones['5000@1'] && a.grupos['5000'])

  const { foto, memoria } = revisarFixture(a)
  const grafana = foto.huerfanos.find((h) => h.pid === 5001)
  assert.equal(grafana?.certeza, 'segura')
  assert.equal(grafana?.veredicto, 'cerrar')
  assert.equal(grafana?.origen?.cwd, '/Users/u/www/old')
  assert.ok(pesoEnBytes(ajustarMemoria(memoria)) <= LIMITE_MEMORIA_BYTES, 'y lo que deja la revisión se guarda igual de ajustado')
})
