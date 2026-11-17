// Las confirmaciones que comparten los dos paneles: qué cierran y qué avisan.
import { assert, test } from 'orca/testing'
import { confirmarForzar, confirmarHuerfanos, confirmarSesion, huerfanosSeguros, resumirHecho, tieneAviso } from './confirmar'
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
  assert.ok(p.notas.some((n) => n.tono === 'danger' && /trabajando/.test(n.texto)))
  if (s.sessionId) assert.ok(p.notas.some((n) => n.texto.includes(`claude --resume ${s.sessionId}`)))
})

test('los huérfanos seguros se cierran de una; los dudosos no entran', () => {
  const f = fotoDePrueba()
  const seguros = huerfanosSeguros(f)
  assert.ok(seguros.length > 0)
  assert.ok(seguros.every((h) => h.certeza === 'segura' && h.nivel === 0))
  const p = confirmarHuerfanos('huerfanos', seguros, f.huerfanos, f.home)!
  assert.deepEqual(p.objetivos.map((o) => o.pid), seguros.map((h) => h.pid))
  assert.equal(confirmarHuerfanos('huerfanos', [], f.huerfanos, f.home), null)
})

test('el resultado cuenta los que siguieron vivos y ofrece forzarlos', () => {
  const f = fotoDePrueba()
  const s = f.sesiones[0]
  const r = resumirHecho({
    origen: `s${s.pid}`,
    titulo: 'Cerré la sesión',
    lista: [
      { pid: s.pid, nombre: 'claude', resultado: 'cerrado' },
      { pid: s.procesos[0].pid, nombre: s.procesos[0].nombre, resultado: 'sigue-vivo' }
    ]
  })
  assert.equal(r.todoBien, false)
  assert.equal(r.titulo, 'Cerré 1 de 2 procesos')
  const forzar = confirmarForzar(`s${s.pid}`, r.vivos, f)!
  assert.equal(forzar.senal, 'KILL')
  assert.deepEqual(forzar.objetivos, [{ pid: s.procesos[0].pid, inicio: s.procesos[0].inicio }])
  assert.equal(confirmarForzar('x', r.vivos, null), null)
})

test('una sesión lleva ⚠ si ella o alguno de sus procesos tiene algo que revisar', () => {
  const s = fotoDePrueba().sesiones[0]
  const limpia = { ...s, veredicto: 'dejar' as const, procesos: s.procesos.map((p) => ({ ...p, veredicto: 'dejar' as const })) }
  assert.equal(tieneAviso(limpia), false)
  assert.equal(tieneAviso({ ...limpia, veredicto: 'revisar' }), true)
})
