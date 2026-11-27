// `orca plugin test .` corre esto en Node con el mismo runtime y los mismos chequeos de Orca.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import { fotoDePrueba } from './fixtures'
import * as panel from './panel'
import type { Foto, HuerfanoListado, Objetivo, ObjetivoWorktree, PedidoDeComando, ResultadoCierre } from './tipos'

type Nodo = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
type Pedido = { objetivos: Objetivo[]; senal: string; arbol: boolean }

/** El primer nodo de `tipo` en el árbol pintado (con ese `label`, si se pide). */
function buscar(nodo: unknown, tipo: string, label?: string): Nodo | null {
  if (Array.isArray(nodo)) {
    for (const n of nodo) {
      const r = buscar(n, tipo, label)
      if (r) return r
    }
    return null
  }
  if (!nodo || typeof nodo !== 'object') return null
  const n = nodo as Nodo
  if (n.type === tipo && (label === undefined || n.props?.label === label)) return n
  return buscar(n.children ?? [], tipo, label)
}

const texto = (nodo: unknown): string => JSON.stringify(nodo ?? null)

/** Las rutas de los worktrees de la foto con esos nombres, en ese orden. */
const worktreesDe = (foto: Foto, nombres: readonly string[]): string[] =>
  nombres.map((n) => foto.worktrees.find((w) => w.nombre === n)!.ruta)

type Comando = { pedido: PedidoDeComando | null }

/** Los huérfanos de la foto con esos pids, como los lista el comando «cerrar huérfanos seguros». */
const listados = (foto: Foto, pids: readonly number[]): HuerfanoListado[] =>
  pids.map((pid) => {
    const h = foto.huerfanos.find((x) => x.pid === pid)!
    return { pid, inicio: h.inicio, nombre: h.nombre }
  })

/** `comando.pedido`: lo que un comando de la paleta dejó para confirmar y nadie ha tomado. */
function hostCon(foto: Foto, pedidos: Pedido[] = [], worktrees: ObjetivoWorktree[][] = [], comando: Comando = { pedido: null }) {
  return mockHost({
    requests: {
      'procesos.foto': () => foto,
      'procesos.tomarConfirmacion': () => {
        const pedido = comando.pedido
        comando.pedido = null
        return { pedido }
      },
      'procesos.cerrarWorktrees': (input) => {
        worktrees.push(input.objetivos)
        const cerrados = new Set(input.objetivos.map((o) => o.ruta))
        const quedan = foto.worktrees.filter((w) => !cerrados.has(w.ruta))
        return {
          resultados: input.objetivos.map((o) => ({ ruta: o.ruta, nombre: o.ruta.split('/').pop()!, resultado: 'cerrado' as const })),
          foto: { ...foto, worktrees: quedan, totales: { ...foto.totales, worktrees: quedan.length, worktreesCerrar: 0, worktreesCerrarKb: 0 } },
          faltan: 0
        }
      },
      'procesos.cerrar': (input) => {
        pedidos.push(input)
        return {
          resultados: input.objetivos.map((o) => ({ pid: o.pid, nombre: `p${o.pid}`, resultado: 'cerrado' as const })),
          foto: {
            ...foto,
            huerfanos: [],
            totales: { ...foto.totales, huerfanos: 0, huerfanosSeguros: 0, huerfanosRssKb: 0, puertosHuerfanos: [] }
          }
        }
      }
    }
  })
}

test('muestra el resumen, las sesiones y el aviso de huérfanos', async () => {
  const view = await mount(panel, { host: hostCon(fotoDePrueba()) })
  assert.match(view.summary().join('\n'), /4 orphaned processes/)
  assert.ok(view.find({ text: 'Sessions (1)' }))
  assert.ok(view.find({ text: 'Orphans (5)' }))
  assert.ok(texto(view.tree()).includes('"title":"⚠ mi-app-c7"'), 'la sesión se ve con su nombre')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('el aviso de huérfanos pregunta en su lugar, con la lista de lo que cierra', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.press({ text: 'Close all' })
  const arbol = texto(view.tree())
  assert.match(view.summary().join('\n'), /Close 2 orphaned processes\?/)
  assert.ok(arbol.includes('mcp-grafana · from “old” · 29 MB'), 'dice de qué sesión viene')
  assert.ok(arbol.includes('Frees :15432.'), 'dice qué puerto libera')
  assert.ok(arbol.includes('2 child processes close with them.'))
  assert.ok(
    arbol.indexOf('Close 2 orphaned processes?') < arbol.indexOf('"type":"Tabs"'),
    'sale donde estaba el aviso, arriba de las pestañas'
  )
  assert.equal(pedidos.length, 0, 'nada se cierra sin confirmar')

  await view.press({ text: 'Close 2 processes' })
  assert.equal(pedidos.length, 1)
  assert.deepEqual(
    pedidos[0].objetivos.map((o) => o.pid),
    [5001, 8800],
    'solo los huérfanos seguros de arriba; sus hijos van por árbol'
  )
  assert.equal(pedidos[0].arbol, true)
  assert.equal(pedidos[0].senal, 'TERM')
  assert.match(view.summary().join('\n'), /Closed 4 processes/)
  await view.press({ text: 'Done' })
  assert.ok(!texto(view.tree()).includes('Closed 4'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cerrar una sesión pregunta dentro de su tarjeta', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.toggle({ type: 'Collapsible' })
  await view.press({ text: 'Close session' })
  const tarjeta = texto(buscar(view.tree(), 'Collapsible'))
  assert.ok(tarjeta.includes('Close the session “mi-app-c7”?'), 'la pregunta está dentro de la tarjeta')
  assert.ok(tarjeta.includes('Closing 7 processes'))
  assert.ok(tarjeta.includes('3 MCP servers'), 'agrupa por tipo')
  assert.ok(tarjeta.includes('It has been idle for 20 h.'))
  assert.ok(tarjeta.includes('claude --resume 0f3c2a9e-5b1d-4c7a-9e2f-7a6b5c4d3e21'))
  assert.ok(tarjeta.includes('Frees :5173.'))

  await view.press({ text: 'Keep it open' })
  assert.equal(pedidos.length, 0)
  assert.ok(!texto(view.tree()).includes('Close the session'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cerrar solo los procesos que sobran deja la sesión abierta', async () => {
  const foto = fotoDePrueba()
  const s = foto.sesiones[0]
  const sobra = s.procesos.find((p) => p.nivel === 1 && p.rol !== 'mcp') ?? s.procesos[0]
  const conSobra: Foto = {
    ...foto,
    sesiones: [{ ...s, procesos: s.procesos.map((p) => (p.pid === sobra.pid ? { ...p, veredicto: 'cerrar' as const } : p)) }]
  }
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(conSobra, pedidos) })
  await view.toggle({ type: 'Collapsible' })
  await view.press({ text: 'Select unneeded' })
  await view.press({ text: 'Close 1 selected' })
  const tarjeta = texto(buscar(view.tree(), 'Collapsible'))
  assert.ok(tarjeta.includes('Close 1 process of “mi-app-c7”?'))
  assert.ok(tarjeta.includes('The session stays open.'))
  await view.press({ text: 'Close 1 process' })
  assert.equal(pedidos.length, 1)
  assert.deepEqual(pedidos[0].objetivos.map((o) => o.pid), [sobra.pid], 'solo el que sobra, no la sesión')
  assert.ok(!pedidos[0].objetivos.some((o) => o.pid === s.pid))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('propone cerrar los worktrees inactivos y pregunta en el lugar del aviso', async () => {
  const pedidos: Pedido[] = []
  const worktrees: ObjetivoWorktree[][] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos, worktrees) })
  assert.match(view.summary().join('\n'), /2 inactive worktrees/)
  assert.ok(view.find({ text: 'Worktrees (6)' }))
  await view.press({ text: 'Close worktrees' })
  const arbol = texto(view.tree())
  assert.match(view.summary().join('\n'), /Close 2 worktrees\?/)
  assert.ok(arbol.includes('Closing (frees 840 MB):'))
  assert.ok(arbol.includes('mi-app/feat+pagos · worktree-feat+pagos · no activity for 12 d · 340 MB'))
  assert.ok(arbol.includes('Their branches and commits stay in the repository.'))
  assert.ok(arbol.indexOf('Close 2 worktrees?') < arbol.indexOf('"type":"Tabs"'), 'sale donde estaba el aviso')
  assert.equal(worktrees.length, 0, 'nada se cierra sin confirmar')

  await view.press({ text: 'Close 2 worktrees' })
  assert.equal(pedidos.length, 0, 'no pide cerrar procesos')
  assert.deepEqual(
    worktrees[0].map((o) => o.ruta.split('/').pop()),
    ['agent-a1b2c3', 'feat+pagos'],
    'solo los inactivos sin nada que perder'
  )
  assert.ok(worktrees[0].every((o) => !o.conCambios))
  assert.match(view.summary().join('\n'), /Closed 2 worktrees/)
  assert.ok(view.find({ text: 'Worktrees (4)' }))
  await view.press({ text: 'Done' })
  assert.ok(!texto(view.tree()).includes('Closed 2 worktrees'))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('la pestaña de worktrees deja elegir, avisa de los cambios y no deja marcar los que están en uso', async () => {
  const worktrees: ObjetivoWorktree[][] = []
  const foto = fotoDePrueba()
  const view = await mount(panel, { host: hostCon(foto, [], worktrees) })
  await view.select({ type: 'Tabs' }, 'worktrees')
  const tabla = buscar(view.tree(), 'Table', 'Git worktrees')
  const filas = (tabla?.props?.rows ?? []) as { key: string; cells: Record<string, unknown>; disabled?: boolean }[]
  assert.deepEqual(
    filas.map((f) => [f.cells.worktree, f.cells.estado, f.disabled]),
    [
      ['mi-app/agent-a1b2c3', 'Close', false],
      ['mi-app/feat+pagos', 'Close', false],
      ['mi-app/tarea', 'Review', true],
      ['mi-app/fix+login', 'Review', false],
      ['mi-app/mi-app-hotfix', 'Keep', false],
      ['mi-app/agent-d4e5f6', 'Keep', true]
    ]
  )
  const login = foto.worktrees.find((w) => w.nombre === 'fix+login')!
  await view.selectRows({ type: 'Table', label: 'Git worktrees' }, [login.ruta])
  const elegido = texto(view.tree())
  assert.ok(elegido.includes('3 uncommitted changes: closing it discards them.'), 'el motivo del elegido')
  assert.ok(elegido.includes('Branch: fix/login · 3 uncommitted changes · Created by: Claude Code'))
  assert.ok(elegido.includes('~/www/mi-app/.claude/worktrees/fix+login'))

  await view.press({ text: 'Close 1 selected' })
  assert.match(view.summary().join('\n'), /Close 1 worktree\?/)
  assert.ok(texto(view.tree()).includes('fix+login has uncommitted changes: they are discarded for good.'))
  await view.press({ text: 'Close 1 worktree' })
  assert.deepEqual(worktrees, [[{ ruta: login.ruta, head: login.head, conCambios: true }]])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('el comando de cerrar worktrees pregunta en la pestaña Worktrees, con la lista, y cancelar no cierra nada', async () => {
  const worktrees: ObjetivoWorktree[][] = []
  const comando: Comando = { pedido: null }
  const foto = fotoDePrueba()
  const view = await mount(panel, { host: hostCon(foto, [], worktrees, comando) })
  assert.equal(view.valueOf({ type: 'Tabs' }), 'sesiones')
  assert.ok(!/Close 2 worktrees\?/.test(view.summary().join('\n')), 'sin el comando no pregunta nada')

  // El comando corre con el panel abierto: el worker avisa y el panel toma el pedido.
  comando.pedido = { de: 'worktrees' }
  await view.post('procesos.confirmar', {})
  await view.settled()
  assert.equal(view.valueOf({ type: 'Tabs' }), 'worktrees', 'abre la pestaña Worktrees')
  assert.match(view.summary().join('\n'), /Close 2 worktrees\?/)
  const arbol = texto(view.tree())
  assert.ok(arbol.includes('Closing (frees 840 MB):'))
  assert.ok(arbol.includes('mi-app/agent-a1b2c3 · feat/exportar · no activity for 28 d · 500 MB'), 'con la lista de lo que cierra')
  assert.ok(arbol.includes('mi-app/feat+pagos · worktree-feat+pagos · no activity for 12 d · 340 MB'))
  assert.ok(arbol.indexOf('Close 2 worktrees?') > arbol.indexOf('"type":"Tabs"'), 'la pregunta sale dentro de la pestaña')
  assert.deepEqual(
    view.valueOf({ type: 'Table', label: 'Git worktrees' }),
    worktreesDe(foto, ['agent-a1b2c3', 'feat+pagos']),
    'y la tabla marca cuáles son'
  )
  assert.equal(comando.pedido, null, 'el pedido ya se tomó: no vuelve a preguntar')
  assert.equal(worktrees.length, 0, 'nada se cierra sin confirmar')

  await view.press({ text: 'Cancel' })
  assert.equal(worktrees.length, 0)
  assert.ok(!/Close 2 worktrees\?/.test(view.summary().join('\n')))
  // Otro aviso sin pedido (lo tomó otro panel, o venció) no pregunta.
  await view.post('procesos.confirmar', {})
  await view.settled()
  assert.ok(!/Close 2 worktrees\?/.test(view.summary().join('\n')))
  assert.equal(worktrees.length, 0)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('si el panel se abre después del comando, encuentra la pregunta; confirmada, cierra solo esos', async () => {
  const pedidos: Pedido[] = []
  const worktrees: ObjetivoWorktree[][] = []
  const foto = fotoDePrueba()
  const view = await mount(panel, { host: hostCon(foto, pedidos, worktrees, { pedido: { de: 'worktrees' } }) })
  await view.settled()
  assert.equal(view.valueOf({ type: 'Tabs' }), 'worktrees')
  assert.match(view.summary().join('\n'), /Close 2 worktrees\?/)
  assert.equal(worktrees.length, 0, 'abrir el panel no cierra nada')

  await view.press({ text: 'Close 2 worktrees' })
  assert.equal(pedidos.length, 0)
  assert.deepEqual(worktrees.map((ws) => ws.map((o) => o.ruta)), [worktreesDe(foto, ['agent-a1b2c3', 'feat+pagos'])])
  assert.ok(worktrees[0].every((o) => !o.conCambios), 'solo los que no tienen nada que perder')
  assert.match(view.summary().join('\n'), /Closed 2 worktrees/)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('el comando de cerrar huérfanos pregunta en la pestaña Huérfanos, con la lista, y cancelar no cierra nada', async () => {
  const pedidos: Pedido[] = []
  const comando: Comando = { pedido: null }
  const foto = fotoDePrueba()
  const view = await mount(panel, { host: hostCon(foto, pedidos, [], comando) })
  assert.equal(view.valueOf({ type: 'Tabs' }), 'sesiones')
  assert.ok(!/Close 2 orphaned processes\?/.test(view.summary().join('\n')), 'sin el comando no pregunta nada')

  // El comando corre con el panel abierto: el worker avisa y el panel toma el pedido.
  comando.pedido = { de: 'huerfanos', huerfanos: listados(foto, [5001, 8800]) }
  await view.post('procesos.confirmar', {})
  await view.settled()
  assert.equal(view.valueOf({ type: 'Tabs' }), 'huerfanos', 'abre la pestaña Huérfanos')
  assert.match(view.summary().join('\n'), /Close 2 orphaned processes\?/)
  const arbol = texto(view.tree())
  assert.ok(arbol.includes('mcp-grafana · from “old” · 29 MB'), 'con la lista de lo que cierra, como el botón')
  assert.ok(arbol.includes('Frees :15432.'))
  assert.ok(arbol.includes('2 child processes close with them.'))
  assert.ok(!arbol.includes('Left out'), 'ninguno cambió')
  assert.ok(arbol.indexOf('Close 2 orphaned processes?') > arbol.indexOf('"type":"Tabs"'), 'la pregunta sale dentro de la pestaña')
  assert.deepEqual(view.valueOf({ type: 'Table', label: 'Orphaned processes' }), ['5001', '8800'], 'y la tabla marca cuáles son')
  assert.equal(comando.pedido, null, 'el pedido ya se tomó: no vuelve a preguntar')
  assert.equal(pedidos.length, 0, 'nada se cierra sin confirmar')

  await view.press({ text: 'Cancel' })
  assert.equal(pedidos.length, 0)
  assert.ok(!/Close 2 orphaned processes\?/.test(view.summary().join('\n')))
  // Otro aviso sin pedido (lo tomó otro panel, o venció) no pregunta.
  await view.post('procesos.confirmar', {})
  await view.settled()
  assert.ok(!/Close 2 orphaned processes\?/.test(view.summary().join('\n')))
  assert.equal(pedidos.length, 0)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('si el panel se abre después del comando de huérfanos, encuentra la pregunta; confirmada, cierra solo esos', async () => {
  const pedidos: Pedido[] = []
  const foto = fotoDePrueba()
  const pedido: PedidoDeComando = { de: 'huerfanos', huerfanos: listados(foto, [5001, 8800]) }
  const view = await mount(panel, { host: hostCon(foto, pedidos, [], { pedido }) })
  await view.settled()
  assert.equal(view.valueOf({ type: 'Tabs' }), 'huerfanos')
  assert.match(view.summary().join('\n'), /Close 2 orphaned processes\?/)
  assert.equal(pedidos.length, 0, 'abrir el panel no cierra nada')

  await view.press({ text: 'Close 2 processes' })
  assert.equal(pedidos.length, 1)
  assert.deepEqual(
    pedidos[0].objetivos,
    listados(foto, [5001, 8800]).map((l) => ({ pid: l.pid, inicio: l.inicio, huerfano: 'segura' })),
    'como huérfanos seguros: el worker los mira otra vez antes de cerrarlos'
  )
  assert.equal(pedidos[0].arbol, true)
  assert.equal(pedidos[0].senal, 'TERM')
  assert.match(view.summary().join('\n'), /Closed 4 processes/)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('los huérfanos que cambiaron desde el comando quedan fuera de la pregunta, y lo dice', async () => {
  const pedidos: Pedido[] = []
  const foto = fotoDePrueba()
  const [grafana, shell] = listados(foto, [5001, 8800])
  const pedido: PedidoDeComando = {
    de: 'huerfanos',
    huerfanos: [
      grafana,
      // El pid 8800 ya es de otro proceso: el que listó el comando arrancó una hora antes.
      { ...shell, inicio: shell.inicio - 3600_000 },
      // Este ya terminó solo.
      { pid: 7777, inicio: grafana.inicio, nombre: 'mcp-viejo' }
    ]
  }
  const view = await mount(panel, { host: hostCon(foto, pedidos, [], { pedido }) })
  await view.settled()
  assert.match(view.summary().join('\n'), /Close 1 orphaned process\?/)
  const arbol = texto(view.tree())
  assert.ok(arbol.includes('mcp-grafana · from “old” · 29 MB'))
  assert.ok(
    arbol.includes(
      `Left out: ${shell.nombre} (8800), mcp-viejo (7777). The command listed them, but they are gone or are no longer the same certain orphans.`
    ),
    'nombra los que no entran'
  )
  assert.deepEqual(view.valueOf({ type: 'Table', label: 'Orphaned processes' }), ['5001'], 'el 8800 de ahora no se marca: no es el que listó el comando')

  await view.press({ text: 'Close 1 process' })
  assert.deepEqual(pedidos.map((p) => p.objetivos.map((o) => o.pid)), [[5001]], 'solo el que sigue igual')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('si ninguno de los que listó el comando sigue igual, no pregunta: dice por qué no cerró nada', async () => {
  const pedidos: Pedido[] = []
  const foto = fotoDePrueba()
  // 4281 es ahora un servidor MCP de la sesión viva; 8900 solo parece de Claude; 7777 ya no está.
  const pedido: PedidoDeComando = {
    de: 'huerfanos',
    huerfanos: [
      { pid: 4281, inicio: foto.sesiones[0].procesos.find((p) => p.pid === 4281)!.inicio, nombre: 'mcp-grafana' },
      ...listados(foto, [8900]),
      { pid: 7777, inicio: foto.tomadaEn, nombre: 'mcp-viejo' }
    ]
  }
  const view = await mount(panel, { host: hostCon(foto, pedidos, [], { pedido }) })
  await view.settled()
  assert.equal(view.valueOf({ type: 'Tabs' }), 'huerfanos')
  const resumen = view.summary().join('\n')
  assert.ok(!/Close \d+ orphaned process(es)?\?/.test(resumen), 'no hay nada que confirmar')
  assert.match(resumen, /Nothing was closed/)
  const arbol = texto(view.tree())
  assert.ok(arbol.includes('mcp-grafana (4281): It is no longer an orphan: it belongs to a live Claude session now.'))
  assert.ok(arbol.includes('(8900): It is no longer a certain orphan. Check it again.'))
  assert.ok(arbol.includes('mcp-viejo (7777): It no longer shows up as a Claude process.'))
  assert.equal(pedidos.length, 0)
  await view.press({ text: 'Done' })
  assert.ok(!/Nothing was closed/.test(view.summary().join('\n')))
  assert.equal(pedidos.length, 0)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('lo que el worker deja sin cerrar porque cambió justo antes sale en el resultado, con el motivo', async () => {
  const foto = fotoDePrueba()
  const pedidos: Pedido[] = []
  const host = mockHost({
    requests: {
      'procesos.foto': () => foto,
      'procesos.tomarConfirmacion': { pedido: { de: 'huerfanos', huerfanos: listados(foto, [5001, 8800]) } },
      'procesos.cerrar': (input) => {
        pedidos.push(input)
        const resultados: ResultadoCierre[] = [
          { pid: 8800, nombre: 'zsh', resultado: 'rechazado', detalle: 'That pid now belongs to another process.' },
          { pid: 5001, nombre: 'mcp-grafana', resultado: 'cerrado' },
          { pid: 5002, nombre: 'python3 helper.py', resultado: 'cerrado' }
        ]
        return { resultados, foto }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.settled()
  await view.press({ text: 'Close 2 processes' })
  assert.equal(pedidos.length, 1)
  assert.match(view.summary().join('\n'), /Closed 2 of 3 processes/)
  assert.ok(texto(view.tree()).includes('zsh (8800): That pid now belongs to another process.'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('un cierre largo responde con lo que lleva y termina con el aviso del worker', async () => {
  const foto = fotoDePrueba()
  const [uno, dos] = foto.worktrees
  const host = mockHost({
    requests: {
      'procesos.foto': () => foto,
      'procesos.tomarConfirmacion': { pedido: null },
      'procesos.cerrarWorktrees': () => ({
        resultados: [{ ruta: uno.ruta, nombre: uno.nombre, resultado: 'cerrado' as const }],
        foto,
        faltan: 1
      })
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Close worktrees' })
  await view.press({ text: 'Close 2 worktrees' })
  assert.match(view.summary().join('\n'), /Still closing 1 worktree/)
  assert.ok(texto(view.tree()).includes('Git is still deleting the folders'))

  await view.post('procesos.worktreesCerrados', {
    resultados: [
      { ruta: uno.ruta, nombre: uno.nombre, resultado: 'cerrado' },
      { ruta: dos.ruta, nombre: dos.nombre, resultado: 'error', detalle: "Git couldn't remove it: busy" }
    ]
  })
  const resumen = view.summary().join('\n')
  assert.match(resumen, /Closed 1 of 2 worktrees/)
  assert.ok(!/Still closing/.test(resumen))
  assert.ok(texto(view.tree()).includes("feat+pagos: Git couldn't remove it: busy"))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('si el pedido vence mientras git borra, no lo da por fallido', async () => {
  const host = mockHost({
    requests: {
      'procesos.foto': () => fotoDePrueba(),
      'procesos.tomarConfirmacion': { pedido: null },
      'procesos.cerrarWorktrees': () => {
        throw hostError('timeout', 'timed out')
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Close worktrees' })
  await view.press({ text: 'Close 2 worktrees' })
  const resumen = view.summary().join('\n')
  assert.match(resumen, /Still closing 2 worktrees/)
  assert.ok(!/Couldn't close/.test(resumen))
  await view.unmount()
})

test('mientras no termina la primera búsqueda, la pestaña de worktrees lo dice', async () => {
  const con = fotoDePrueba()
  const foto: Foto = { ...con, worktrees: [], worktreesRevisados: null, totales: { ...con.totales, worktrees: 0, worktreesCerrar: 0 } }
  const view = await mount(panel, { host: hostCon(foto) })
  assert.ok(view.find({ text: 'Worktrees (0)' }))
  await view.select({ type: 'Tabs' }, 'worktrees')
  assert.ok(texto(view.tree()).includes('Looking for worktrees'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cancelar no cierra nada', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.press({ text: 'Close all' })
  await view.press({ text: 'Cancel' })
  assert.equal(pedidos.length, 0)
  assert.ok(!/Close 2 orphaned processes\?/.test(view.summary().join('\n')))
  await view.unmount()
})

test('si el worker falla lo dice', async () => {
  const host = mockHost({
    requests: {
      'procesos.foto': () => {
        throw new Error('ps no respondió')
      }
    }
  })
  const view = await mount(panel, { host })
  assert.match(view.summary().join('\n'), /The worker didn't respond/)
  await view.unmount()
})
