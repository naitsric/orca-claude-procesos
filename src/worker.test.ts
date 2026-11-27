// Corre activate(orca) de src/worker.ts sobre un host simulado. Usa el ps y el lsof de verdad de
// esta máquina (orca plugin test corre sin sandbox), así que solo revisa la forma, no los números.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
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
