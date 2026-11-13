// La lógica que decide qué es de Claude y qué cerrar, contra el sistema inventado de fixtures.ts.
import { assert, test } from 'orca/testing'
import {
  AHORA,
  COMM_DESACOPLADO,
  infosDePrueba,
  memoriaConSesionMuerta,
  PS_DESACOPLADO,
  revisarFixture
} from './fixtures'
import { comandoDeBash, cerrables, memoriaVacia, nombreDe, parsearPs, segundosDeEtime } from './procesos'

test('lee etime en todos sus formatos', () => {
  assert.equal(segundosDeEtime('05'), 0)
  assert.equal(segundosDeEtime('02:00'), 120)
  assert.equal(segundosDeEtime('1:30:00'), 5400)
  assert.equal(segundosDeEtime('2-00:00:01'), 172801)
})

test('saca el comando que la herramienta Bash le pasó al shell', () => {
  const cmd = `/bin/zsh -c source x && eval 'echo '\\''hola'\\'' | wc' < /dev/null && pwd -P`
  assert.equal(comandoDeBash(cmd), "echo 'hola' | wc")
  assert.equal(comandoDeBash('/bin/zsh -l'), null)
})

test('nombra node y python por lo que corren', () => {
  const [py, node] = parsearPs(
    [
      ' 10 1 10 501 ?? 01:00 1 0.0 /x/bin/python -m aws_mcp --flag',
      ' 11 1 11 501 ?? 01:00 1 0.0 node /x/pkg/dist/index.js'
    ].join('\n'),
    ' 10 /x/bin/python\n 11 node',
    AHORA
  )
  assert.equal(nombreDe(py, 'mcp'), 'python -m aws_mcp')
  assert.equal(nombreDe(node, 'mcp'), 'node dist/index.js')
})

test('salta los subcomandos de uv y usa el título del proceso', () => {
  const [uv, npm, pyc, mayus] = parsearPs(
    [
      ' 10 1 10 501 ?? 01:00 1 0.0 /x/bin/uv tool uvx mcp-proxy-for-aws@latest https://x',
      ' 11 1 11 501 ?? 01:00 1 0.0 npm exec @playwright/mcp@latest',
      ' 12 1 12 501 ?? 01:00 1 0.0 /x/bin/python -c import sys; print(1)',
      ' 13 1 13 501 ?? 01:00 1 0.0 /Library/Frameworks/Python.framework/Python script.py'
    ].join('\n'),
    ' 10 /x/bin/uv\n 11 npm exec @playwright/mcp@latest\n 12 /x/bin/python\n 13 /Library/Frameworks/Python.framework/Python',
    AHORA
  )
  assert.equal(nombreDe(uv, 'mcp'), 'uv mcp-proxy-for-aws@latest')
  assert.equal(nombreDe(npm, 'mcp'), 'npm exec @playwright/mcp@latest')
  assert.equal(nombreDe(pyc, 'comando'), 'python -c')
  assert.equal(nombreDe(mayus, 'comando'), 'Python script.py')
})

test('agrupa la sesión viva con sus procesos y su anfitrión', () => {
  const { foto } = revisarFixture(memoriaConSesionMuerta())
  assert.equal(foto.sesiones.length, 1)
  const s = foto.sesiones[0]
  assert.equal(s.pid, 4129)
  assert.equal(s.anfitrion, 'Orca')
  assert.equal(s.reanuda, '7d1e9a42-bbbb')
  assert.equal(s.cwd, '/Users/u/www/mi-app')
  assert.equal(s.veredicto, 'dejar')
  const porPid = new Map(s.procesos.map((p) => [p.pid, p]))
  assert.deepEqual([...porPid.keys()].sort(), [4154, 4160, 4281, 7766, 9214, 9220])
  assert.equal(porPid.get(4154)!.rol, 'mcp')
  assert.equal(porPid.get(4160)!.rol, 'mcp')
  assert.equal(porPid.get(4160)!.nivel, 1)
  assert.equal(porPid.get(4160)!.nombre, 'python -m aws_mcp')
  assert.equal(porPid.get(4281)!.veredicto, 'dejar')
  assert.equal(porPid.get(7766)!.rol, 'despierto')
  const bash = porPid.get(9214)!
  assert.equal(bash.rol, 'bash')
  assert.equal(bash.nombre, "$ npm run dev -- --port '5173'")
  assert.equal(bash.veredicto, 'revisar', 'un comando en segundo plano de más de una hora se revisa')
  const vite = porPid.get(9220)!
  assert.equal(vite.rol, 'servidor')
  assert.deepEqual(vite.puertos, [5173])
  assert.match(vite.motivo, /:5173/)
})

test('encuentra los huérfanos y dice de dónde vienen', () => {
  const { foto } = revisarFixture(memoriaConSesionMuerta())
  const pids = foto.huerfanos.map((h) => h.pid)
  assert.deepEqual(pids, [8900, 5001, 5002, 8800, 8801], 'en orden de inicio, cada uno con su subárbol')
  assert.ok(!pids.includes(8000), 'un npm start de launchd no es de Claude')

  const [mcpSuelto, grafana, hijo, shell, tunel] = foto.huerfanos
  assert.equal(mcpSuelto.certeza, 'probable')
  assert.equal(mcpSuelto.veredicto, 'revisar')

  assert.equal(grafana.certeza, 'segura')
  assert.equal(grafana.veredicto, 'cerrar')
  assert.equal(grafana.origen?.pid, 5000)
  assert.match(grafana.motivo, /old terminó hace 1 h/)
  assert.equal(hijo.nivel, 1)
  assert.equal(hijo.veredicto, 'cerrar')

  assert.equal(shell.certeza, 'segura', 'la marca de shell-snapshots basta')
  assert.equal(shell.origen, null)
  assert.equal(tunel.rol, 'tunel')
  assert.deepEqual(tunel.puertos, [15432])

  assert.equal(foto.totales.huerfanos, 5)
  assert.equal(foto.totales.huerfanosSeguros, 4)
  assert.deepEqual(foto.totales.puertosHuerfanos, [15432])
})

test('recuerda grupos y linaje para la próxima revisión', () => {
  const { memoria } = revisarFixture(memoriaConSesionMuerta())
  assert.ok(memoria.grupos['4129'], 'el grupo de la sesión')
  assert.ok(memoria.grupos['9214'], 'el grupo del shell de Bash')
  assert.deepEqual(Object.keys(memoria.linaje).sort(), ['4154', '4160', '4281', '7766', '9214', '9220'])
  assert.equal(memoria.sesiones['5000@1'].termino, AHORA - 3600_000, 'la sesión muerta queda con su última vista')
})

test('un proceso que se desprende de una sesión viva queda con ella, marcado', () => {
  const primera = revisarFixture(memoriaVacia())
  const segunda = revisarFixture(primera.memoria, { ps: PS_DESACOPLADO, comm: COMM_DESACOPLADO })
  const s = segunda.foto.sesiones[0]
  const suelto = s.procesos.find((p) => p.pid === 9300)
  assert.ok(suelto, 'aparece bajo la sesión 4129')
  assert.equal(suelto!.desacoplado, true)
  assert.equal(suelto!.veredicto, 'revisar')
  assert.ok(!segunda.foto.huerfanos.some((h) => h.pid === 9300))
})

test('sin memoria, un MCP de una sesión muerta solo queda como probable', () => {
  const { foto } = revisarFixture(memoriaVacia())
  const grafana = foto.huerfanos.find((h) => h.pid === 5001)
  assert.equal(grafana?.certeza, 'probable', 'sin el grupo recordado no se puede asegurar')
  assert.equal(grafana?.veredicto, 'revisar')
  assert.deepEqual(
    foto.huerfanos.filter((h) => h.certeza === 'segura').map((h) => h.pid),
    [8800, 8801],
    'el shell de Bash sí se reconoce por su marca'
  )
})

test('olvida las sesiones muertas después de una semana', () => {
  const { memoria } = revisarFixture(memoriaConSesionMuerta(), {}, AHORA + 8 * 24 * 3600_000)
  assert.equal(memoria.sesiones['5000@1'], undefined)
  assert.equal(memoria.grupos['5000'], undefined)
})

test('usa el nombre y el estado que publica Claude Code', () => {
  const { foto, memoria } = revisarFixture(memoriaConSesionMuerta(), { infos: infosDePrueba() })
  const s = foto.sesiones[0]
  assert.equal(s.nombre, 'mi-app-c7')
  assert.equal(s.sessionId, '0f3c2a9e-5b1d-4c7a-9e2f-7a6b5c4d3e21')
  assert.equal(s.estado, 'idle')
  assert.equal(s.veredicto, 'revisar', 'inactiva 20 h con un umbral de 12 h')
  assert.match(s.motivo, /Inactiva desde hace 20 h/)
  assert.match(s.motivo, /claude --resume 0f3c2a9e/)
  assert.equal(memoria.sesiones[Object.keys(memoria.sesiones).find((k) => k.startsWith('4129@'))!].nombre, 'mi-app-c7')
})

test('una sesión trabajando se deja aunque lleve horas abierta', () => {
  const infos = infosDePrueba()
  infos.set(4129, { ...infos.get(4129)!, estado: 'busy', estadoDesde: AHORA - 60_000 })
  const s = revisarFixture(memoriaVacia(), { infos }).foto.sesiones[0]
  assert.equal(s.veredicto, 'dejar')
  assert.equal(s.motivo, 'Trabajando desde hace 1 min.')
})

test('ignora el archivo de sesión de otro proceso que tuvo el mismo pid', () => {
  const infos = infosDePrueba()
  infos.set(4129, { ...infos.get(4129)!, inicio: AHORA - 30 * 3600_000 })
  const s = revisarFixture(memoriaVacia(), { infos }).foto.sesiones[0]
  assert.equal(s.nombre, null)
  assert.equal(s.sessionId, '7d1e9a42-bbbb', 'queda el --resume de la línea de comando')
})

test('solo deja cerrar lo que está en la foto', () => {
  const { foto } = revisarFixture(memoriaConSesionMuerta())
  const permitidos = cerrables(foto)
  assert.ok(permitidos.has(4129))
  assert.ok(permitidos.has(5001))
  assert.ok(!permitidos.has(8000))
  assert.ok(!permitidos.has(1668))
})
