// `orca plugin test .` corre esto en Node con el mismo runtime y los mismos chequeos de Orca.
import { assert, mockHost, mount, test } from 'orca/testing'
import { fotoDePrueba } from './fixtures'
import * as panel from './panel'
import type { Foto, Objetivo } from './tipos'

type Nodo = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
type Pedido = { objetivos: Objetivo[]; senal: string; arbol: boolean }

/** El primer nodo de `tipo` en el árbol pintado. */
function buscar(nodo: unknown, tipo: string): Nodo | null {
  if (Array.isArray(nodo)) {
    for (const n of nodo) {
      const r = buscar(n, tipo)
      if (r) return r
    }
    return null
  }
  if (!nodo || typeof nodo !== 'object') return null
  const n = nodo as Nodo
  if (n.type === tipo) return n
  return buscar(n.children ?? [], tipo)
}

const texto = (nodo: unknown): string => JSON.stringify(nodo ?? null)

function hostCon(foto: Foto, pedidos: Pedido[] = []) {
  return mockHost({
    requests: {
      'procesos.foto': () => foto,
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
