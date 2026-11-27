// Las confirmaciones que comparten los dos paneles: qué cierran y qué avisan.
import { assert, test } from 'orca/testing'
import {
  confirmarForzar,
  confirmarHuerfanos,
  confirmarListados,
  confirmarSesion,
  huerfanosSeguros,
  resumirHecho,
  tieneAviso
} from './confirmar'
import { AHORA, fotoDePrueba, HOME } from './fixtures'

test('cerrar una sesión apunta a su claude, avisa si trabaja y dice cómo retomarla', () => {
  const f = fotoDePrueba()
  const s = { ...f.sesiones[0], estado: 'busy' }
  const p = confirmarSesion(s, HOME, AHORA)
  assert.equal(p.origen, `s${s.pid}`)
  assert.equal(p.tono, 'danger')
  assert.equal(p.objetivos[0].pid, s.pid)
  assert.equal(p.senal, 'TERM')
  assert.ok(p.arbol, 'se cierra con todo su árbol')
  assert.ok(p.notas.some((n) => n.tono === 'danger' && /working now/.test(n.texto)))
  if (s.sessionId) assert.ok(p.notas.some((n) => n.texto.includes(`claude --resume ${s.sessionId}`)))
})

test('los huérfanos seguros se cierran de una; los dudosos no entran', () => {
  const f = fotoDePrueba()
  const seguros = huerfanosSeguros(f)
  assert.ok(seguros.length > 0)
  assert.ok(seguros.every((h) => h.certeza === 'segura' && h.nivel === 0))
  const p = confirmarHuerfanos('huerfanos', seguros, f.huerfanos, f.home)!
  assert.deepEqual(
    p.objetivos,
    seguros.map((h) => ({ pid: h.pid, inicio: h.inicio, huerfano: 'segura' })),
    'se piden como huérfanos seguros: el worker deja al que ya no lo sea'
  )
  assert.equal(confirmarHuerfanos('huerfanos', [], f.huerfanos, f.home), null)
  const dudoso = f.huerfanos.find((h) => h.certeza === 'probable')!
  assert.deepEqual(confirmarHuerfanos('huerfanos', [dudoso], f.huerfanos, f.home)!.objetivos, [
    { pid: dudoso.pid, inicio: dudoso.inicio, huerfano: 'probable' }
  ])
})

test('lo que listó el comando de cerrar huérfanos se confirma como con el botón, y solo eso', () => {
  const f = fotoDePrueba()
  const seguros = huerfanosSeguros(f)
  const lista = seguros.map((h) => ({ pid: h.pid, inicio: h.inicio, nombre: h.nombre }))
  const boton = confirmarHuerfanos('huerfanos', seguros, f.huerfanos, f.home)!
  const { pendiente, cambiaron } = confirmarListados('huerfanos', lista, f)
  assert.deepEqual(pendiente, boton, 'la misma confirmación')
  assert.deepEqual(cambiaron, [])

  // Solo uno de los dos: el otro huérfano seguro de la foto no entra, el comando no lo listó.
  const uno = confirmarListados('huerfanos', lista.slice(0, 1), f)
  assert.deepEqual(uno.pendiente!.objetivos.map((o) => o.pid), [lista[0].pid])
  assert.deepEqual(uno.cambiaron, [])
  assert.deepEqual(confirmarListados('huerfanos', [], f), { pendiente: null, cambiaron: [] })
})

test('de lo que listó el comando, lo que cambió antes de confirmar queda fuera con su motivo', () => {
  const f = fotoDePrueba()
  const [grafana, shell] = huerfanosSeguros(f)
  const dudoso = f.huerfanos.find((h) => h.certeza === 'probable')!
  const deSesion = f.sesiones[0].procesos[0]
  const { pendiente, cambiaron } = confirmarListados(
    'huerfanos',
    [
      { pid: grafana.pid, inicio: grafana.inicio, nombre: grafana.nombre },
      { pid: shell.pid, inicio: shell.inicio - 3600_000, nombre: shell.nombre },
      { pid: dudoso.pid, inicio: dudoso.inicio, nombre: dudoso.nombre },
      { pid: deSesion.pid, inicio: deSesion.inicio, nombre: deSesion.nombre },
      { pid: 7777, inicio: grafana.inicio, nombre: 'mcp-viejo' }
    ],
    f
  )
  assert.deepEqual(pendiente!.objetivos, [{ pid: grafana.pid, inicio: grafana.inicio, huerfano: 'segura' }])
  assert.equal(pendiente!.titulo, 'Close 1 orphaned process?')
  assert.deepEqual(
    cambiaron.map((r) => [r.pid, r.resultado, r.detalle]),
    [
      [shell.pid, 'rechazado', 'That pid now belongs to another process.'],
      [dudoso.pid, 'rechazado', 'It is no longer a certain orphan. Check it again.'],
      [deSesion.pid, 'rechazado', 'It is no longer an orphan: it belongs to a live Claude session now.'],
      [7777, 'rechazado', 'It no longer shows up as a Claude process.']
    ]
  )
  const nota = pendiente!.notas[0]
  assert.equal(nota.tono, 'warning')
  assert.match(nota.texto, /^Left out: .*mcp-viejo \(7777\)\. The command listed them/)

  // Si no queda ninguno no hay nada que confirmar, y el resultado dice que no se cerró nada.
  const ninguno = confirmarListados('huerfanos', [{ pid: 7777, inicio: grafana.inicio, nombre: 'mcp-viejo' }], f)
  assert.equal(ninguno.pendiente, null)
  const r = resumirHecho({ origen: 'huerfanos', titulo: 'x', lista: ninguno.cambiaron })
  assert.equal(r.titulo, 'Nothing was closed')
  assert.equal(r.todoBien, false)
  assert.deepEqual(r.lineas, ['mcp-viejo (7777): It no longer shows up as a Claude process.'])
})

test('el resultado cuenta los que siguieron vivos y ofrece forzarlos', () => {
  const f = fotoDePrueba()
  const s = f.sesiones[0]
  const r = resumirHecho({
    origen: `s${s.pid}`,
    titulo: 'Closed the session',
    lista: [
      { pid: s.pid, nombre: 'claude', resultado: 'cerrado' },
      { pid: s.procesos[0].pid, nombre: s.procesos[0].nombre, resultado: 'sigue-vivo' }
    ]
  })
  assert.equal(r.todoBien, false)
  assert.equal(r.titulo, 'Closed 1 of 2 processes')
  const forzar = confirmarForzar(`s${s.pid}`, r.vivos, f)!
  assert.equal(forzar.senal, 'KILL')
  assert.deepEqual(forzar.objetivos, [{ pid: s.procesos[0].pid, inicio: s.procesos[0].inicio }])
  assert.equal(confirmarForzar('x', r.vivos, null), null)
  // Forzar a un huérfano que no respondió también lo pide como huérfano.
  const h = huerfanosSeguros(f)[0]
  assert.deepEqual(confirmarForzar('huerfanos', [{ pid: h.pid, nombre: h.nombre, resultado: 'sigue-vivo' }], f)!.objetivos, [
    { pid: h.pid, inicio: h.inicio, huerfano: 'segura' }
  ])
})

test('una sesión lleva ⚠ si ella o alguno de sus procesos tiene algo que revisar', () => {
  const s = fotoDePrueba().sesiones[0]
  const limpia = { ...s, veredicto: 'dejar' as const, procesos: s.procesos.map((p) => ({ ...p, veredicto: 'dejar' as const })) }
  assert.equal(tieneAviso(limpia), false)
  assert.equal(tieneAviso({ ...limpia, veredicto: 'revisar' }), true)
})
