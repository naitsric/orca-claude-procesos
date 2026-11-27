// Corre activate(orca) de src/worker.ts sobre un host simulado. Usa el ps y el lsof de verdad de
// esta máquina (orca plugin test corre sin sandbox), así que solo revisa la forma, no los números.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { INTERVALO_MUESTRA_MS, LIMITE_VALOR_BYTES, pesoEnBytes, VENTANA_MS } from './historial'
import type { Historial, Muestra } from './tipos'
import * as main from './worker'

test('revisa la máquina, publica la foto y actualiza la barra', async () => {
  const host = mockHost({ settings: { intervaloSegundos: 300, avisarHuerfanos: false } })
  const worker = await mountWorker(main, { host, commands: ['revisar', 'cerrar-huerfanos', 'cerrar-worktrees'] })
  const foto = await worker.request('procesos.foto')
  assert.equal(foto.error, undefined, foto.error)
  assert.ok(Array.isArray(foto.sesiones))
  assert.ok(foto.totales.procesos >= foto.totales.sesiones)
  assert.ok(worker.posts.some((p) => p.event === 'procesos.foto'))
  const barra = host.callsOf('statusBar.update') as readonly { text: string }[]
  assert.ok(barra.length > 0)
  assert.match(barra[barra.length - 1].text, /^Claude \d+/)

  const texto = await worker.command('revisar')
  assert.match(String(texto), /Claude sessions?/)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('no cierra pids que no son de Claude', async () => {
  const host = mockHost({ settings: { intervaloSegundos: 300, avisarHuerfanos: false } })
  const worker = await mountWorker(main, { host })
  const { resultados } = await worker.request('procesos.cerrar', {
    objetivos: [{ pid: 1, inicio: 0 }],
    senal: 'TERM',
    arbol: false
  })
  assert.equal(resultados.length, 1)
  assert.equal(resultados[0].resultado, 'rechazado')
  await worker.deactivate()
})

test('no cierra un worktree que no encontró, ni la carpeta principal de un repositorio', async () => {
  const host = mockHost({ settings: { intervaloSegundos: 300, avisarHuerfanos: false, avisarWorktrees: false } })
  const worker = await mountWorker(main, { host })
  const { resultados, faltan, foto } = await worker.request('procesos.cerrarWorktrees', {
    objetivos: [{ ruta: '/no/existe/este-worktree', head: 'abc', conCambios: true }]
  })
  assert.equal(resultados.length, 1)
  assert.equal(resultados[0].resultado, 'rechazado')
  assert.equal(faltan, 0)
  assert.ok(Array.isArray(foto.worktrees))
  assert.ok(foto.worktreesRevisados !== null, 'la foto ya trae lo que leyó para decidir')
  assert.ok(foto.worktrees.every((w) => w.ruta !== w.repo), 'la carpeta principal nunca está en la lista')
  await worker.deactivate()
})

/** Media hora de muestras hasta ahora mismo, una cada 5 s, con `n` sesiones inventadas. */
function historialGuardado(n: number): Historial {
  const ahora = Date.now()
  const muestras: Muestra[] = []
  for (let t = ahora - VENTANA_MS + 60_000; t <= ahora - 10_000; t += INTERVALO_MUESTRA_MS) {
    muestras.push({
      t,
      sesiones: Array.from({ length: n }, (_, i) => ({ clave: `s${70000 + i}`, nombre: `proyecto-${i}`, cpu: 12.5, rssKb: 400000 + i })),
      huerfanosCpu: 0,
      huerfanosRssKb: 0
    })
  }
  const colores = Object.fromEntries(muestras[0].sesiones.map((s, i) => [s.clave, i < 5 ? i : -1]))
  return { muestras, colores, intervaloMs: INTERVALO_MUESTRA_MS }
}

test('un historial guardado que pasa del límite de storage se reemplaza solo por uno que cabe', async () => {
  const guardado = historialGuardado(15)
  assert.ok(pesoEnBytes(guardado) > LIMITE_VALOR_BYTES, 'el valor guardado no cabría hoy')
  const host = mockHost({
    settings: { intervaloSegundos: 300, avisarHuerfanos: false, avisarWorktrees: false },
    storage: { historial: JSON.parse(JSON.stringify(guardado)) }
  })
  const worker = await mountWorker(main, { host })
  // Apagar el worker pase lo que pase: sus temporizadores dejarían la corrida colgada.
  try {
    const recibido = await worker.request('procesos.historial')
    assert.ok(pesoEnBytes(recibido) <= LIMITE_VALOR_BYTES, 'lo que recibe el panel cabe')
    assert.ok(recibido.muestras.length > 100, 'y conserva la media hora, resumida')
    assert.ok(recibido.muestras[0].t - guardado.muestras[0].t < 60_000)
    assert.ok(recibido.muestras.at(-1)!.t >= guardado.muestras.at(-1)!.t)
    assert.equal(recibido.muestras[0].sesiones.length, 15)

    const enStorage = host.data().storage.historial as Historial
    assert.ok(pesoEnBytes(enStorage) <= LIMITE_VALOR_BYTES, `storage quedó en ${pesoEnBytes(enStorage)} bytes`)
    assert.ok(enStorage.muestras.length > 100, 'sin borrar el historial que había')
    assert.deepEqual(worker.logs.filter((l) => /muestrear|storage/.test(l)), [])
  } finally {
    await worker.deactivate()
  }
})

test('nunca le pide a storage guardar un valor de más de 256 KiB', async () => {
  const host = mockHost({
    settings: { intervaloSegundos: 300, avisarHuerfanos: false, avisarWorktrees: false },
    storage: { historial: JSON.parse(JSON.stringify(historialGuardado(60))) }
  })
  const worker = await mountWorker(main, { host })
  try {
    await worker.request('procesos.historial')
    await worker.request('procesos.foto')
    const guardados = host.calls.filter((c) => c.method === 'storage.set').map((c) => c.params as { key: string; value: unknown })
    assert.ok(guardados.some((g) => g.key === 'historial'))
    for (const g of guardados) assert.ok(pesoEnBytes(g.value) <= LIMITE_VALOR_BYTES, `${g.key}: ${pesoEnBytes(g.value)} bytes`)
  } finally {
    await worker.deactivate()
  }
})
