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
  assert.match(view.summary().join('\n'), /4 procesos huérfanos/)
  assert.ok(view.find({ text: 'Sesiones (1)' }))
  assert.ok(view.find({ text: 'Huérfanos (5)' }))
  assert.ok(texto(view.tree()).includes('"title":"⚠ mi-app-c7"'), 'la sesión se ve con su nombre')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('el aviso de huérfanos pregunta en su lugar, con la lista de lo que cierra', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.press({ text: 'Cerrar todos' })
  const arbol = texto(view.tree())
  assert.match(view.summary().join('\n'), /¿Cerrar 2 procesos huérfanos\?/)
  assert.ok(arbol.includes('mcp-grafana · de «old» · 29 MB'), 'dice de qué sesión viene')
  assert.ok(arbol.includes('Libera :15432.'), 'dice qué puerto libera')
  assert.ok(arbol.includes('Con ellos se cierran 2 procesos hijos.'))
  assert.ok(
    arbol.indexOf('¿Cerrar 2 procesos huérfanos?') < arbol.indexOf('"type":"Tabs"'),
    'sale donde estaba el aviso, arriba de las pestañas'
  )
  assert.equal(pedidos.length, 0, 'nada se cierra sin confirmar')

  await view.press({ text: 'Cerrar 2 procesos' })
  assert.equal(pedidos.length, 1)
  assert.deepEqual(
    pedidos[0].objetivos.map((o) => o.pid),
    [5001, 8800],
    'solo los huérfanos seguros de arriba; sus hijos van por árbol'
  )
  assert.equal(pedidos[0].arbol, true)
  assert.equal(pedidos[0].senal, 'TERM')
  assert.match(view.summary().join('\n'), /Cerré 4 procesos/)
  await view.press({ text: 'Listo' })
  assert.ok(!texto(view.tree()).includes('Cerré'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cerrar una sesión pregunta dentro de su tarjeta', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.toggle({ type: 'Collapsible' })
  await view.press({ text: 'Cerrar sesión' })
  const tarjeta = texto(buscar(view.tree(), 'Collapsible'))
  assert.ok(tarjeta.includes('¿Cerrar la sesión «mi-app-c7»?'), 'la pregunta está dentro de la tarjeta')
  assert.ok(tarjeta.includes('Se cierran 7 procesos'))
  assert.ok(tarjeta.includes('3 servidores MCP'), 'agrupa por tipo')
  assert.ok(tarjeta.includes('Está inactiva desde hace 20 h.'))
  assert.ok(tarjeta.includes('claude --resume 0f3c2a9e-5b1d-4c7a-9e2f-7a6b5c4d3e21'))
  assert.ok(tarjeta.includes('Libera :5173.'))

  await view.press({ text: 'Mantenerla abierta' })
  assert.equal(pedidos.length, 0)
  assert.ok(!texto(view.tree()).includes('¿Cerrar la sesión'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('cancelar no cierra nada', async () => {
  const pedidos: Pedido[] = []
  const view = await mount(panel, { host: hostCon(fotoDePrueba(), pedidos) })
  await view.press({ text: 'Cerrar todos' })
  await view.press({ text: 'Cancelar' })
  assert.equal(pedidos.length, 0)
  assert.ok(!/¿Cerrar/.test(view.summary().join('\n')))
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
  assert.match(view.summary().join('\n'), /El worker no respondió/)
  await view.unmount()
})
