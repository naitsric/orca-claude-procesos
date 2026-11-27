// Corre activate(orca) de src/worker.ts sobre un host simulado. Usa el ps y el lsof de verdad de
// esta máquina (orca plugin test corre sin sandbox), así que solo revisa la forma, no los números.
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { nombreWorktree, worktreesParaCerrar } from './confirmar'
import { INTERVALO_MUESTRA_MS, LIMITE_VALOR_BYTES, pesoEnBytes, VENTANA_MS } from './historial'
import { LIMITE_MEMORIA_BYTES } from './memoria'
import { memoriaVacia, type Memoria } from './procesos'
import type { Foto, Historial, Muestra } from './tipos'
import * as main from './worker'
import { objetivoDe } from './worktrees'

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

const UN_DIA = 24 * 3600_000

/** `n` sesiones que terminaron a lo largo de la última semana, sin procesos vivos: la 0 es la más vieja. */
function memoriaGuardada(n: number): Memoria {
  const ahora = Date.now()
  const m = memoriaVacia()
  for (let i = 0; i < n; i++) {
    const termino = ahora - 6 * UN_DIA + Math.round(((i + 1) * 6 * UN_DIA) / (n + 1))
    const pid = 100_000 + i
    m.sesiones[`${pid}@${Math.round((termino - 3600_000) / 1000)}`] = {
      pid,
      inicio: termino - 3600_000,
      pgid: pid,
      cwd: `/no/existe/proyecto-${i % 40}/tarea-${i}`,
      nombre: `tarea-${i}`,
      vista: termino,
      termino
    }
  }
  return m
}

const QUIETO = { intervaloSegundos: 300, avisarHuerfanos: false, avisarWorktrees: false }

test('una memoria guardada que pasa del límite de storage se reemplaza sola por una que cabe, y la revisión no falla', async () => {
  const guardada = memoriaGuardada(3000)
  assert.ok(pesoEnBytes(guardada) > LIMITE_VALOR_BYTES, 'el valor guardado no cabría hoy')
  const host = mockHost({ settings: QUIETO, storage: { memoria: JSON.parse(JSON.stringify(guardada)) } })
  const worker = await mountWorker(main, { host })
  try {
    const foto = await worker.request('procesos.foto')
    assert.equal(foto.error, undefined, foto.error)

    const guardados = host.calls.filter((c) => c.method === 'storage.set').map((c) => c.params as { key: string; value: unknown })
    const deMemoria = guardados.filter((g) => g.key === 'memoria')
    assert.ok(deMemoria.length > 0, 'la guardó')
    for (const g of guardados) assert.ok(pesoEnBytes(g.value) <= LIMITE_VALOR_BYTES, `${g.key}: ${pesoEnBytes(g.value)} bytes`)
    for (const g of deMemoria) assert.ok(pesoEnBytes(g.value) <= LIMITE_MEMORIA_BYTES)
    // Lo primero que hace con ella, antes de la revisión, es dejarla en storage como cabe.
    const primerGuardado = host.calls.findIndex((c) => c.method === 'storage.set' && (c.params as { key: string }).key === 'memoria')
    const primeraFoto = host.calls.findIndex((c) => c.method === 'statusBar.update')
    assert.ok(primerGuardado < primeraFoto, 'sin esperar a que una revisión salga bien')

    const enStorage = host.data().storage.memoria as Memoria
    const quedan = Object.keys(enStorage.sesiones).filter((clave) => clave in guardada.sesiones)
    const todas = Object.keys(guardada.sesiones)
    assert.ok(quedan.length > 1000, `quedan ${quedan.length} de las que había`)
    assert.deepEqual(quedan, todas.slice(todas.length - quedan.length), 'las más nuevas; se fueron las más viejas')
    assert.deepEqual(worker.logs.filter((l) => /revisar|storage/.test(l)), [])
  } finally {
    await worker.deactivate()
  }
})

test('una memoria guardada que cabe se conserva entera: las sesiones se recuerdan la semana completa', async () => {
  const guardada = memoriaGuardada(120)
  const host = mockHost({ settings: QUIETO, storage: { memoria: JSON.parse(JSON.stringify(guardada)) } })
  const worker = await mountWorker(main, { host })
  try {
    assert.equal((await worker.request('procesos.foto')).error, undefined)
    const enStorage = host.data().storage.memoria as Memoria
    for (const clave of Object.keys(guardada.sesiones)) assert.ok(enStorage.sesiones[clave], `falta ${clave}`)
  } finally {
    await worker.deactivate()
  }
})

test('si storage rechaza la memoria, la revisión sigue y lo deja en el registro', async () => {
  const host = mockHost({
    settings: QUIETO,
    results: {
      'storage.set': () => {
        throw hostError('too_large', 'value is larger than 262144 bytes')
      }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    const foto = await worker.request('procesos.foto')
    assert.equal(foto.error, undefined, foto.error)
    assert.ok(foto.totales.procesos >= foto.totales.sesiones)
    // Solo hay algo que guardar (y que rechazar) si esta máquina tiene una sesión de Claude abierta.
    if (foto.totales.sesiones) assert.ok(worker.logs.some((l) => /storage\.set memoria: .*262144/.test(l)))
  } finally {
    await worker.deactivate()
  }
})

function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, '-c', 'user.name=prueba', '-c', 'user.email=prueba@example.com', '-c', 'commit.gpgsign=false', ...args],
      { env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => (error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(stdout))
    )
  })
}

const existe = (ruta: string): Promise<boolean> => access(ruta).then(() => true, () => false)

/**
 * Un repositorio `mi-app` de verdad, en una carpeta temporal, donde «se abrió Claude Code», con
 * dos worktrees que nadie toca hace años: `viejo`, sin nada que perder, y `sucio`, con un archivo
 * sin guardar. El worker los encuentra por el `.claude.json` de esa carpeta.
 */
async function conRepoInactivo(fn: (repo: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(`${tmpdir()}/claude-procesos-`))
  const configPrevia = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = `${dir}/config`
  try {
    const repo = `${dir}/mi-app`
    await mkdir(`${repo}/src`, { recursive: true })
    await mkdir(`${dir}/config`, { recursive: true })
    await writeFile(`${dir}/config/.claude.json`, JSON.stringify({ projects: { [repo]: {} } }))
    await git(repo, 'init', '-q', '-b', 'main')
    await writeFile(`${repo}/src/a.txt`, 'a\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-q', '-m', 'inicio')
    const hace = new Date(Date.UTC(2001, 0, 1))
    for (const nombre of ['viejo', 'sucio']) {
      const ruta = `${repo}/.claude/worktrees/${nombre}`
      await git(repo, 'worktree', 'add', '-q', `.claude/worktrees/${nombre}`, '-b', `worktree-${nombre}`)
      if (nombre === 'sucio') await writeFile(`${ruta}/sin guardar.txt`, 'trabajo a medias\n')
      // Las fechas que el plugin mira para saber cuándo se tocó por última vez.
      const propio = `${repo}/.git/worktrees/${nombre}`
      for (const f of [`${ruta}/sin guardar.txt`, `${propio}/HEAD`, `${propio}/index`, `${propio}/logs/HEAD`, ruta]) {
        if (await existe(f)) await utimes(f, hace, hace)
      }
    }
    await fn(repo)
  } finally {
    if (configPrevia === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configPrevia
    await rm(dir, { recursive: true, force: true })
  }
}

test('el comando de cerrar worktrees inactivos no cierra nada: dice cuáles son y deja la pregunta para el panel', async () => {
  await conRepoInactivo(async (repo) => {
    const viejo = `${repo}/.claude/worktrees/viejo`
    const sucio = `${repo}/.claude/worktrees/sucio`
    const host = mockHost({ settings: QUIETO })
    const worker = await mountWorker(main, { host, commands: ['revisar', 'cerrar-huerfanos', 'cerrar-worktrees'] })
    try {
      assert.deepEqual(await worker.request('procesos.tomarConfirmacion'), { pedida: false }, 'sin el comando no hay nada que confirmar')

      const texto = String(await worker.command('cerrar-worktrees'))
      // La foto que el comando publicó justo antes de pedir la confirmación: la que verá el panel.
      const pedido = worker.posts.findIndex((p) => p.event === 'procesos.confirmarWorktrees')
      assert.ok(pedido > 0, 'le pide a los paneles que pregunten')
      const foto = worker.posts.slice(0, pedido).filter((p) => p.event === 'procesos.foto').at(-1)!.payload as Foto
      const inactivos = worktreesParaCerrar(foto)
      const elViejo = inactivos.find((w) => w.ruta === viejo)
      assert.ok(elViejo, 'el worktree viejo y limpio está entre los que propone')
      assert.ok(!inactivos.some((w) => w.ruta === sucio), 'el que tiene cambios sin guardar, no')

      assert.match(texto, new RegExp(`^${inactivos.length} inactive worktrees? with nothing to lose: `))
      for (const w of inactivos.slice(0, 5)) assert.ok(texto.includes(nombreWorktree(w)), `nombra ${nombreWorktree(w)}`)
      assert.match(texto, /Nothing was closed: confirm in the Worktrees tab of the Claude Processes panel\.$/)

      // Nada se cerró, ni aquí ni en los repositorios de verdad de esta máquina.
      assert.ok(await existe(`${viejo}/src/a.txt`))
      assert.match(await git(repo, 'worktree', 'list', '--porcelain'), /worktrees\/viejo\n/)
      assert.deepEqual(worker.logs.filter((l) => /cerrar worktrees/.test(l)), [])
      for (const w of inactivos) if (!w.falta) assert.ok(await existe(w.ruta), `${w.ruta} sigue ahí`)

      // Un solo panel toma el pedido, una vez; con eso pregunta y, si se cancela, no pasa nada más.
      assert.deepEqual(await worker.request('procesos.tomarConfirmacion'), { pedida: true })
      assert.deepEqual(await worker.request('procesos.tomarConfirmacion'), { pedida: false })
      assert.ok(await existe(`${viejo}/src/a.txt`))

      // Solo la confirmación del panel cierra, y solo lo que el panel pide.
      const { resultados } = await worker.request('procesos.cerrarWorktrees', { objetivos: [objetivoDe(elViejo)] })
      assert.deepEqual(resultados.map((r) => [r.nombre, r.resultado]), [['viejo', 'cerrado']])
      assert.ok(!(await existe(viejo)))
      assert.ok(await existe(`${sucio}/sin guardar.txt`))
      assert.match(await git(repo, 'branch', '--list'), /worktree-viejo/, 'la rama se queda')
      assert.deepEqual(worker.refusals, [])
    } finally {
      await worker.deactivate()
    }
  })
})

test('si nadie responde, el pedido del comando vence y no se cierra nada', async () => {
  await conRepoInactivo(async (repo) => {
    const host = mockHost({ settings: QUIETO })
    const worker = await mountWorker(main, { host, commands: ['revisar', 'cerrar-huerfanos', 'cerrar-worktrees'] })
    const ahora = Date.now
    try {
      assert.match(String(await worker.command('cerrar-worktrees')), /Nothing was closed/)
      // Once minutos después alguien abre el panel: ya no hay pregunta esperándolo.
      Date.now = () => ahora() + 11 * 60_000
      assert.deepEqual(await worker.request('procesos.tomarConfirmacion'), { pedida: false })
      Date.now = ahora
      assert.ok(await existe(`${repo}/.claude/worktrees/viejo/src/a.txt`))
      assert.deepEqual(worker.logs.filter((l) => /cerrar worktrees/.test(l)), [])
    } finally {
      Date.now = ahora
      await worker.deactivate()
    }
  })
})
