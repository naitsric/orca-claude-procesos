// Corre activate(orca) de src/worker.ts sobre un host simulado. Usa el ps y el lsof de verdad de
// esta máquina (orca plugin test corre sin sandbox), así que solo revisa la forma, no los números.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('revisa la máquina, publica la foto y actualiza la barra', async () => {
  const host = mockHost({ settings: { intervaloSegundos: 300, avisarHuerfanos: false } })
  const worker = await mountWorker(main, { host, commands: ['revisar', 'cerrar-huerfanos'] })
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
